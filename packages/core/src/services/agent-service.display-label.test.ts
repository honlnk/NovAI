import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  listSessions,
  updateQueuedMessage,
  _clearSessionCacheForTest,
} from './agent-service'
import { loadSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'

/**
 * 斜杠命令显示/指令分离（交互优化计划 §3.2）：displayLabel（用户原草稿）随消息
 * 落盘并进入气泡/队列/自动标题；展开后的内部 prompt 只进模型，不出现在
 * 标题等用户可见处。QueueDock 编辑重推导后 text/displayLabel 一起更新。
 */

vi.mock('../core/agent/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/agent/query')>()
  return {
    ...actual,
    query: vi.fn(),
  }
})

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

const mockedQuery = vi.mocked(query)

const stubConfig = {
  project: { name: 'Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
  },
} as unknown as ProjectConfig

/** 内部 prompt 的可识别片段（测试用假 prompt，仅验证不外露） */
const SECRET_PROMPT_MARK = '内部驱动指令标记-Xy9'

describe('displayLabel 显示/指令分离', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    mockedQuery.mockResolvedValue([])
    project = buildProject()
    setRuntimeProject(project)
  })

  it('带 displayLabel 入队：排队消息与落盘 user 消息携带，自动标题用原草稿', async () => {
    const { sessionId } = await createSession('proj-dl')

    // 空闲入队 = 立即消费为一个 turn：driver 收尾后队列已抽干，消息已落 user 气泡
    await enqueueMessage({
      projectId: 'proj-dl',
      sessionId,
      text: `内部驱动指令标记-Xy9 全文……`,
      displayLabel: '/管理要素 整理人物',
      mode: 'queue',
    })
    await vi.waitFor(async () => {
      const session = await loadSession(project, sessionId)
      expect(session?.messages.some((m) => m.role === 'user' && m.kind === 'text')).toBe(true)
    })

    const session = (await loadSession(project, sessionId))!
    const userMessage = session.messages.find((m) => m.role === 'user' && m.kind === 'text')
    expect(userMessage).toBeDefined()
    // 气泡显示原草稿；内部 prompt 在 text（模型视图），不进显示字段
    expect(userMessage!.displayLabel).toBe('/管理要素 整理人物')
    expect(userMessage!.text).toContain(SECRET_PROMPT_MARK)

    // 自动标题来自 displayLabel（命令名+参数），不含内部 prompt 痕迹
    const summary = (await listSessions('proj-dl')).find((s) => s.sessionId === sessionId)
    expect(summary?.title).toContain('/管理要素')
    expect(summary?.title).not.toContain(SECRET_PROMPT_MARK)
  })

  it('不带 displayLabel 入队（普通消息）：消息无该字段，标题用 text', async () => {
    const { sessionId } = await createSession('proj-dl')

    await enqueueMessage({
      projectId: 'proj-dl',
      sessionId,
      text: '帮我写第三章的开头',
      mode: 'queue',
    })
    await vi.waitFor(async () => {
      const session = await loadSession(project, sessionId)
      expect(session?.messages.some((m) => m.role === 'user' && m.kind === 'text')).toBe(true)
    })

    const session = (await loadSession(project, sessionId))!
    const userMessage = session.messages.find((m) => m.role === 'user' && m.kind === 'text')
    expect(userMessage?.displayLabel).toBeUndefined()

    const summary = (await listSessions('proj-dl')).find((s) => s.sessionId === sessionId)
    expect(summary?.title).toContain('帮我写第三章的开头')
  })

  it('排队（运行中再入队）时队列消息带 displayLabel；编辑重推导两个字段一起更新', async () => {
    // query 挂起 = driver 常驻运行，第二次入队留在队列里
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const { sessionId } = await createSession('proj-dl')
    await enqueueMessage({ projectId: 'proj-dl', sessionId, text: '第一轮', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())

    await enqueueMessage({
      projectId: 'proj-dl',
      sessionId,
      text: `${SECRET_PROMPT_MARK} 全文……`,
      displayLabel: '/生成项目记忆',
      mode: 'queue',
    })

    // 队列消息带 displayLabel 落盘
    const queued = (await loadSession(project, sessionId))?.inbox?.nextTurn[0]
    expect(queued?.displayLabel).toBe('/生成项目记忆')
    expect(queued?.text).toContain(SECRET_PROMPT_MARK)

    // 编辑重推导：新草稿命中命令 → 新 prompt + 新 displayLabel
    await updateQueuedMessage({
      projectId: 'proj-dl',
      sessionId,
      id: queued!.id,
      action: { kind: 'edit', text: `${SECRET_PROMPT_MARK} 新全文`, displayLabel: '/生成项目记忆 补充设定' },
    })
    const edited = (await loadSession(project, sessionId))?.inbox?.nextTurn[0]
    expect(edited?.displayLabel).toBe('/生成项目记忆 补充设定')
    expect(edited?.text).toContain('新全文')

    // 编辑成普通文本（无 displayLabel）：命令标记清除，回退渲染 text
    await updateQueuedMessage({
      projectId: 'proj-dl',
      sessionId,
      id: queued!.id,
      action: { kind: 'edit', text: '改成普通消息' },
    })
    const stripped = (await loadSession(project, sessionId))?.inbox?.nextTurn[0]
    expect(stripped?.displayLabel).toBeUndefined()
    expect(stripped?.text).toBe('改成普通消息')

    releaseQuery([])
  })
})

// ---------- 测试夹具 ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-dl',
    name: 'DisplayLabel Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-dl',
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
