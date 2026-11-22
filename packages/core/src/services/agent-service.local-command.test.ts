import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  compactSession,
  createSession,
  _clearSessionCacheForTest,
} from './agent-service'
import { isChatDriverActive, compactChatSession } from '../core/chat/session'
import { loadSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ChatMessage, ProjectConfig, ProjectSnapshot } from '../types/project'

/**
 * 本地命令紧凑状态行（交互优化计划 §3.2）：/压缩上下文 执行后落一条
 * local-command 消息随会话持久化，区分已完成/未执行/失败三态。
 */

vi.mock('../core/agent/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/agent/query')>()
  return {
    ...actual,
    query: vi.fn(),
  }
})

vi.mock('../core/chat/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/chat/session')>()
  return {
    ...actual,
    compactChatSession: vi.fn(actual.compactChatSession),
  }
})

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

const mockedQuery = vi.mocked(query)
const mockedCompact = vi.mocked(compactChatSession)

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

describe('本地命令状态行（/压缩上下文）', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    mockedQuery.mockResolvedValue([])
    mockedCompact.mockReset()
    project = buildProject()
    setRuntimeProject(project)
  })

  it('压缩完成：落 completed 状态行', async () => {
    const { sessionId } = await createSession('proj-cc')
    mockedCompact.mockResolvedValue({ kind: 'compacted', compactedMessageCount: 12, originalTokens: 5000, summaryTokens: 800 })

    await compactSession({ projectId: 'proj-cc', sessionId })

    const session = (await loadSession(project, sessionId))!
    const line = session.messages.find((m): m is ChatMessage & { kind: 'local-command' } => m.kind === 'local-command')
    expect(line).toBeDefined()
    expect(line!.command).toBe('/压缩上下文')
    expect(line!.outcome).toBe('completed')
    expect(line!.summary).toContain('12 条')
  })

  it('没有可压缩内容：落 noop 状态行（未执行 ≠ 失败）', async () => {
    const { sessionId } = await createSession('proj-cc')
    mockedCompact.mockResolvedValue({ kind: 'noop', reason: 'nothing-to-compact' })

    await compactSession({ projectId: 'proj-cc', sessionId })

    const session = (await loadSession(project, sessionId))!
    const line = session.messages.find((m): m is ChatMessage & { kind: 'local-command' } => m.kind === 'local-command')
    expect(line?.outcome).toBe('noop')
    expect(line?.summary).toContain('未做修改')
    expect(line?.summary).not.toContain('失败')
  })

  it('摘要被拒：落 failed 状态行，detail 可复制且不含堆栈', async () => {
    const { sessionId } = await createSession('proj-cc')
    mockedCompact.mockResolvedValue({ kind: 'noop', reason: 'summary-rejected' })

    await compactSession({ projectId: 'proj-cc', sessionId })

    const session = (await loadSession(project, sessionId))!
    const line = session.messages.find((m): m is ChatMessage & { kind: 'local-command' } => m.kind === 'local-command')
    expect(line?.outcome).toBe('failed')
    expect(line?.detail).toBeTypeOf('string')
    expect(line?.detail ?? '').not.toMatch(/at .+:\d+/) // 不存异常堆栈
  })

  it('driver 运行中拒绝：不落状态行（抛错由 UI 就地提示，避免与运行中落盘竞态）', async () => {
    const { sessionId } = await createSession('proj-cc')
    // 挂起 query 模拟运行中
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))
    const { enqueueMessage } = await import('./agent-service')
    await enqueueMessage({ projectId: 'proj-cc', sessionId, text: '跑着', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    expect(isChatDriverActive(sessionId)).toBe(true)

    await expect(compactSession({ projectId: 'proj-cc', sessionId })).rejects.toThrow('运行中')

    const session = (await loadSession(project, sessionId))!
    expect(session.messages.some((m) => m.kind === 'local-command')).toBe(false)

    releaseQuery([])
  })
})

// ---------- 测试夹具 ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-cc',
    name: 'Compact Command Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-cc',
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
