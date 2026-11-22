import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  getSession,
  respondConfirmation,
  stopAgentRun,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent, RunAgentTurnResult } from './types'

/**
 * 写工具确认链（交互优化计划 §8）service 层端到端：CreateFile/EditFile →
 * confirmation-required 广播 + 确认注册表挂起 → UI respondConfirmation 唤醒。
 * 本文件聚焦批1新增的两处收敛语义：
 * 1. 停止运行收敛——stopAgentRun 同时按拒绝清理挂起确认（不泄漏注册表条目）；
 * 2. 会话路由——respondConfirmation 携带 expectedSessionId 且与注册不符时不 resolve
 *   （§8 按会话路由不串答）；携带正确会话或省略（旧调用方）时照常放行。
 * 另覆盖 edit 确认视图的 replaceAll 透传（确认面板多出现处预览的依据）。
 */

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-confirm-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

// ---------- fetch stub（SSE 编排，照 ask-user-question 测试） ----------

let fetchCalls: Array<{ messages: Array<{ role: string; content?: string | null }>; toolNames: string[] }> = []
let mainCallIndex = 0
/** 第 1 拍出招（默认 CreateFile 确认），个别用例覆盖 */
let firstResponse: () => Response

function sseResponse(lines: string[]): Response {
  const text = lines.map((line) => `data: ${line}\n\n`).join('\n') + 'data: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function toolCallSse(id: string, name: string, args: Record<string, unknown>): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls',
      }],
    }),
  ])
}

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
  ])
}

beforeEach(() => {
  fetchCalls = []
  mainCallIndex = 0
  firstResponse = () => toolCallSse('t-create-1', 'CreateFile', {
    path: 'chapters/第013章-雨停.txt',
    content: '第013章 雨停\n\n雨停了。\n',
  })
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    fetchCalls.push({
      messages: body.messages ?? [],
      toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
    })
    if (mainCallIndex === 0) {
      mainCallIndex += 1
      return firstResponse()
    }
    return textSse('确认已处理，本轮到此为止。')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- 内存文件系统 fixture（照 ask-user-question 测试） ----------

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createDirectoryHandle(entry: MemoryDirectoryEntry): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') return createDirectoryHandle(current)
      if (current) throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') return createFileHandle(current)
      if (current) throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, { type: 'text/plain', lastModified: entry.lastModified })
    },
    async createWritable() {
      let nextContent = ''
      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob ? await data.text() : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

const stubConfig = {
  project: { name: 'Confirm Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://main.example.com/v1', apiKey: 'key', model: 'main-model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    // 仅审阅档：任何写工具（含 chapters/ 的内容修改）都逐次确认——本文件聚焦确认链语义
    permissionPreset: 'review',
  },
} as unknown as ProjectConfig

let rootEntry: MemoryDirectoryEntry | null = null

function buildProject(): ProjectSnapshot {
  const root: MemoryDirectoryEntry = { kind: 'directory', name: 'novel', entries: new Map() }
  // 预置一章，供 EditFile 用例替换
  const chapters: MemoryDirectoryEntry = { kind: 'directory', name: 'chapters', entries: new Map() }
  chapters.entries.set('第012章-旧约.txt', {
    kind: 'file',
    name: '第012章-旧约.txt',
    content: '第012章 旧约\n\n蹙眉不语。\n',
    lastModified: Date.now(),
  })
  root.entries.set('chapters', chapters)
  root.entries.set('prompts', {
    kind: 'directory',
    name: 'prompts',
    entries: new Map([
      ['system.md', { kind: 'file', name: 'system.md', content: '系统提示', lastModified: Date.now() } as MemoryFileEntry],
    ]),
  })
  rootEntry = root
  const handle = createDirectoryHandle(root)
  return {
    id: 'proj-confirm',
    name: 'Confirm Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-confirm',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

/** 读取内存 FS 里的文件内容（不存在返回 null） */
async function readMemoryFile(dirName: string, fileName: string): Promise<string | null> {
  const dir = rootEntry?.entries.get(dirName)
  if (dir?.kind !== 'directory') return null
  const file = dir.entries.get(fileName)
  return file?.kind === 'file' ? file.content : null
}

let mainSessionId = ''

describe('写工具确认链：停止收敛与会话路由（§8 批1）', () => {
  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    setRuntimeProject(buildProject())
    const main = await createSession('proj-confirm')
    mainSessionId = main.sessionId
  })

  it('停止运行：挂起确认按拒绝收敛，本轮收尾、文件未写入、注册表清空', async () => {
    const events: AgentUiEvent[] = []
    const stopped = new Promise<void>((resolve, reject) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        events.push(event)
        if (event.type === 'confirmation-required' && event.sessionId === mainSessionId) {
          // 用户没点确认，先点了「停止运行」
          queueMicrotask(() => stopAgentRun(mainSessionId))
        }
        if (event.type === 'run-finish' && event.sessionId === mainSessionId) {
          unsubscribe()
          resolve()
        }
        if (event.type === 'run-error' && event.sessionId === mainSessionId) {
          unsubscribe()
          reject(new Error(event.error.message))
        }
      })
    })
    await enqueueMessage({ projectId: 'proj-confirm', text: '写第 13 章', mode: 'queue' })
    await stopped

    // 本轮已停止：不再发第 2 次模型请求
    expect(fetchCalls).toHaveLength(1)

    // 确认被按拒绝收敛 → CreateFile 不落盘（真实工具结果为准，本地停止不假装写入）
    expect(await readMemoryFile('chapters', '第013章-雨停.txt')).toBeNull()

    // 注册表收敛：confirmations-updated 最终快照为空（徽标熄灭）
    const snapshots = events.filter((event) => event.type === 'confirmations-updated')
    expect(snapshots.at(-1)).toMatchObject({ type: 'confirmations-updated', confirmations: [] })

    // 停止收尾落了改动小结（与提问停止路径一致）
    const session = await getSession('proj-confirm', mainSessionId)
    expect(session?.messages.some((m) => m.kind === 'change-summary')).toBe(true)
  })

  it('respondConfirmation 会话路由：错误 expectedSessionId 不 resolve，正确会话放行', async () => {
    const finished = new Promise<RunAgentTurnResult>((resolve, reject) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        if (event.type === 'run-finish' && event.sessionId === mainSessionId) {
          unsubscribe()
          resolve(event.result)
        }
        if (event.type === 'run-error' && event.sessionId === mainSessionId) {
          unsubscribe()
          reject(new Error(event.error.message))
        }
      })
    })
    await enqueueMessage({ projectId: 'proj-confirm', text: '写第 13 章', mode: 'queue' })

    // 等确认卡到达（不自动作答）
    const required = await new Promise<Extract<AgentUiEvent, { type: 'confirmation-required' }>>((resolve) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        if (event.type === 'confirmation-required' && event.sessionId === mainSessionId) {
          unsubscribe()
          resolve(event)
        }
      })
    })
    const confirmationId = required.request.id

    // 错误会话自证：不 resolve、不广播、驱动继续挂起
    respondConfirmation(confirmationId, true, 'session-other')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetchCalls).toHaveLength(1)

    // 正确会话放行 → 工具真实执行 → 收敛
    respondConfirmation(confirmationId, true, mainSessionId)
    await finished

    expect(await readMemoryFile('chapters', '第013章-雨停.txt')).toContain('雨停了')
    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
  })

  it('edit 确认视图透传 replaceAll（确认面板多出现处预览的依据）；默认不带该标志', async () => {
    const seen: Array<Record<string, unknown>> = []
    const finished = new Promise<void>((resolve, reject) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        if (event.type === 'confirmation-required' && event.sessionId === mainSessionId) {
          seen.push(event.request.confirmation as unknown as Record<string, unknown>)
          queueMicrotask(() => respondConfirmation(event.request.id, false))
        }
        if (event.type === 'run-finish' && event.sessionId === mainSessionId) {
          unsubscribe()
          resolve()
        }
        if (event.type === 'run-error' && event.sessionId === mainSessionId) {
          unsubscribe()
          reject(new Error(event.error.message))
        }
      })
    })

    mainCallIndex = 0
    firstResponse = () => toolCallSse('t-read-1', 'ReadFile', { path: 'chapters/第012章-旧约.txt' })
    let editCall = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}')
      fetchCalls.push({
        messages: body.messages ?? [],
        toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
      })
      if (mainCallIndex === 0) {
        mainCallIndex += 1
        return firstResponse()
      }
      if (editCall === 0) {
        editCall += 1
        return toolCallSse('t-edit-1', 'EditFile', {
          path: 'chapters/第012章-旧约.txt',
          oldText: '蹙眉不语',
          newText: '低头叹息',
          replaceAll: true,
        })
      }
      if (editCall === 1) {
        editCall += 1
        return toolCallSse('t-edit-2', 'EditFile', {
          path: 'chapters/第012章-旧约.txt',
          oldText: '蹙眉不语',
          newText: '抬眼望灯',
        })
      }
      return textSse('两处编辑都被拒绝，本轮不再改写。')
    }))

    await enqueueMessage({ projectId: 'proj-confirm', text: '改第 12 章', mode: 'queue' })
    await finished

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({
      kind: 'edit',
      path: 'chapters/第012章-旧约.txt',
      oldText: '蹙眉不语',
      newText: '低头叹息',
      replaceAll: true,
    })
    // 未勾选全部替换的普通编辑：视图不带 replaceAll 键
    expect(seen[1]).toMatchObject({ kind: 'edit', oldText: '蹙眉不语' })
    expect(seen[1]).not.toHaveProperty('replaceAll')
  })
})
