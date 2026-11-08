import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  archiveAgentSession,
  createSession,
  deleteSession,
  enqueueMessage,
  getSession,
  respondQuestion,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
  _getCachedSessionIdsForTest,
} from './agent-service'
import { loadSession, saveSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import type { AgentUiEvent, ProjectConfig, ProjectSnapshot } from './types'
import type { ChatSessionState } from '../types/chat'

/**
 * 提问/回答链路的持久化事件序回归（数据安全计划 §3-4，fetch 真链路版）：
 * - F4：等待回答（questionMap 挂起）的会话不被 LRU 淘汰；
 * - F5：提问卡落盘（fire-and-forget background）失败必须广播 session-save-failed，
 *   且不阻塞其他会话的保存队列；提问卡与回答两次 background 保存串行落盘，
 *   磁盘最终是已回答的卡片；
 * - 删除与在途提问卡保存并发：排空队列后删文件，不复活。
 *
 * 全链只 stub fetch（SSE 编排），工具/会话/驱动/提问注册表全真实（照
 * ask-user-question 测试）；saveSession 包一层可控闸门与按会话的失败注入。
 */

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-qp-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

// 可控写盘闸门：从某会话的第 N 次保存开始挂起（前 N-1 次正常执行）
let holdSaves = false
const saveGates: Array<() => void> = []
const holdFromNthSave = new Map<string, number>()
const failFromNthSave = new Map<string, number>()

vi.mock('../core/chat/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/chat/session-store')>()
  const saveCountBySession = new Map<string, number>()
  return {
    ...actual,
    saveSession: vi.fn(
      async (project: ProjectSnapshot, session: ChatSessionState, options?: { touchUpdatedAt?: boolean }) => {
        const count = (saveCountBySession.get(session.sessionId) ?? 0) + 1
        saveCountBySession.set(session.sessionId, count)
        if (count >= (failFromNthSave.get(session.sessionId) ?? Number.POSITIVE_INFINITY)) {
          throw new Error(`模拟落盘失败：${session.sessionId}（第 ${count} 次）`)
        }
        if (holdSaves && count >= (holdFromNthSave.get(session.sessionId) ?? Number.POSITIVE_INFINITY)) {
          await new Promise<void>((resolve) => saveGates.push(resolve))
        }
        return actual.saveSession(project, session, options)
      },
    ),
  }
})

const stubConfig = {
  project: { name: 'QPersist Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://main.example.com/v1', apiKey: 'key', model: 'main-model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

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

/** 装一个 fetch stub：第 1 次出提问工具，之后每次回普通文本 */
function stubFetchWithQuestion(questionCallId: string): void {
  let callIndex = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (callIndex === 0) {
      callIndex += 1
      return toolCallSse(questionCallId, 'AskUserQuestion', {
        question: '主角接下来去哪？',
        options: [{ label: '北上' }, { label: '南下' }],
      })
    }
    return textSse('收到回答，继续推进。')
  }))
}

async function waitForHeldSaves(n: number): Promise<void> {
  await vi.waitFor(() => expect(saveGates.length).toBeGreaterThanOrEqual(n))
}

function releaseOneSave(): void {
  const gate = saveGates.shift()
  if (gate) gate()
}

/** 先订阅再触发的事件等待（避免广播先于订阅的竞态） */
function subscribeEventOnce(type: AgentUiEvent['type'], sessionId?: string): Promise<AgentUiEvent> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.type === type && (!sessionId || event.sessionId === sessionId)) {
        unsubscribe()
        resolve(event)
      }
    })
  })
}

describe('提问/回答链路的持久化与缓存保护（数据安全计划 §3-4）', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    holdSaves = false
    saveGates.length = 0
    holdFromNthSave.clear()
    failFromNthSave.clear()
    project = buildProject()
    setRuntimeProject(project)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('等待回答（提问挂起）的会话不被 LRU 淘汰', async () => {
    stubFetchWithQuestion('qp-protect')

    const { sessionId } = await createSession('proj-q')
    const questionEvent = subscribeEventOnce('question-required', sessionId)
    await enqueueMessage({ projectId: 'proj-q', sessionId, text: '推进剧情', mode: 'queue' })
    await questionEvent

    // 缓存压力：再建 17 条，把提问中的会话挤成最旧条目（旧实现会被淘汰）
    for (let i = 0; i < 17; i += 1) {
      await createSession('proj-q')
    }

    const ids = _getCachedSessionIdsForTest()
    expect(ids).toContain(sessionId)
    expect(ids).toHaveLength(16)

    respondQuestion({ questionId: 'qp-protect', selectedLabels: ['北上'], text: '' })
    const finishEvent = subscribeEventOnce('run-finish', sessionId)
    await finishEvent
  })

  it('提问卡落盘失败广播 session-save-failed，且不阻塞其他会话保存', async () => {
    stubFetchWithQuestion('qp-fail')

    const { sessionId } = await createSession('proj-q')
    // 该会话第 3 次保存（= 提问卡落盘，background 路径）开始失败；
    // 前 2 次（createSession、enqueueMessage 耐久入队）保持成功才能走到提问。
    failFromNthSave.set(sessionId, 3)

    const saveFailedEvents: AgentUiEvent[] = []
    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.type === 'session-save-failed') {
        saveFailedEvents.push(event)
      }
    })

    await enqueueMessage({ projectId: 'proj-q', sessionId, text: '推进剧情', mode: 'queue' })
    await vi.waitFor(() => expect(saveFailedEvents.length).toBeGreaterThanOrEqual(1))
    unsubscribe()

    expect(saveFailedEvents[0]!.type === 'session-save-failed' && saveFailedEvents[0]!.reason).toBe('提问卡落盘')

    // 其他会话的保存不被无关失败阻塞：另建会话归档照常落盘
    const other = await createSession('proj-q')
    const archived = await archiveAgentSession('proj-q', other.sessionId, true)
    expect(archived.archivedAt).toBeTypeOf('string')
    const onDisk = await loadSession(project, other.sessionId)
    expect(onDisk?.archivedAt).toBeTypeOf('string')
  })

  it('提问与回答乱序落盘：磁盘最终是已回答的卡片（background 路径串行）', async () => {
    stubFetchWithQuestion('qp-order')

    const { sessionId } = await createSession('proj-q')
    const questionEvent = subscribeEventOnce('question-required', sessionId)
    await enqueueMessage({ projectId: 'proj-q', sessionId, text: '推进剧情', mode: 'queue' })
    await questionEvent

    // 回答先落盘（background 入队），收尾的整份落盘排在它后面：
    // run-finish 在收尾保存完成后才广播，等到它即可断言全部 prior 保存已完成
    respondQuestion({ questionId: 'qp-order', selectedLabels: ['南下'], text: '补给不足' })
    const finishEvent = subscribeEventOnce('run-finish', sessionId)
    await finishEvent

    const onDisk = await loadSession(project, sessionId)
    const card = onDisk?.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toBeDefined()
    if (card?.kind === 'ask-user-question') {
      expect(card.answer?.selectedLabels).toEqual(['南下'])
      expect(card.answer?.text).toBe('补给不足')
      expect(card.answer?.outcome).toBe('answered')
    }
  })

  it('删除与在途提问卡保存并发：排空队列后删文件，不复活、不读回', async () => {
    stubFetchWithQuestion('qp-delete')

    const { sessionId } = await createSession('proj-q')
    // 第 3 次保存（提问卡落盘）挂起：制造「background 写盘在途」
    //（前 2 次：createSession、enqueueMessage 耐久入队，正常执行）
    holdSaves = true
    holdFromNthSave.set(sessionId, 3)

    const questionEvent = subscribeEventOnce('question-required', sessionId)
    await enqueueMessage({ projectId: 'proj-q', sessionId, text: '推进剧情', mode: 'queue' })
    await questionEvent
    await waitForHeldSaves(1)

    // 删除开始：排空在途保存后再删文件（旧实现删完后被在途写复活）
    const deleting = deleteSession('proj-q', sessionId)
    releaseOneSave()
    await deleting

    expect(await loadSession(project, sessionId)).toBeNull()
    expect(await getSession('proj-q', sessionId)).toBeNull()
    expect(_getCachedSessionIdsForTest()).not.toContain(sessionId)

    holdSaves = false
  })
})

// ---------- 内存文件系统 fixture（照 ask-user-question 测试） ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-q',
    name: 'QPersist Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-q',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

function seedFile(root: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()!
  let current = root.__entry
  for (const segment of segments) {
    let next = current.entries.get(segment)
    if (!next) {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }
    if (next.kind !== 'directory') throw new Error(`fixture 冲突：${segment}`)
    current = next
  }
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({ kind: 'directory', name, entries: new Map() })
}

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
