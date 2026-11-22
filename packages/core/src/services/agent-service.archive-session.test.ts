import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  archiveAgentSession,
  createSession,
  enqueueMessage,
  listSessions,
  _clearSessionCacheForTest,
} from './agent-service'
import { isChatDriverActive } from '../core/chat/session'
import { loadSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'

/**
 * 会话归档（交互优化计划 §3.3）：archivedAt 只增删不改 updatedAt；
 * 归档不停止运行中的 driver，收尾落盘不丢归档标记；列表透传 archivedAt + status。
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

describe('会话归档', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    mockedQuery.mockResolvedValue([])
    project = buildProject()
    setRuntimeProject(project)
  })

  it('归档写入 archivedAt 且不改 updatedAt；恢复清空 archivedAt', async () => {
    const { sessionId } = await createSession('proj-arc')
    const before = (await listSessions('proj-arc')).find((s) => s.sessionId === sessionId)
    expect(before?.archivedAt).toBeUndefined()
    expect(before?.status).toBe('idle')

    const archived = await archiveAgentSession('proj-arc', sessionId, true)
    expect(archived.archivedAt).toBeTypeOf('string')
    expect(archived.updatedAt).toBe(before?.updatedAt) // 归档不动活动时间
    expect(archived.status).toBe(before?.status)

    // 落盘原样保留（touchUpdatedAt: false）
    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.archivedAt).toBe(archived.archivedAt)
    expect(onDisk?.updatedAt).toBe(before?.updatedAt)

    // 恢复：清空标记，updatedAt 依旧不动
    const restored = await archiveAgentSession('proj-arc', sessionId, false)
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.updatedAt).toBe(before?.updatedAt)
    const afterRestore = await loadSession(project, sessionId)
    expect(afterRestore?.archivedAt).toBeUndefined()
  })

  it('listSessions 透传 archivedAt 与 status', async () => {
    const first = await createSession('proj-arc')
    const second = await createSession('proj-arc')
    await archiveAgentSession('proj-arc', first.sessionId, true)

    const summaries = await listSessions('proj-arc')
    const archived = summaries.find((s) => s.sessionId === first.sessionId)
    const active = summaries.find((s) => s.sessionId === second.sessionId)
    expect(archived?.archivedAt).toBeTypeOf('string')
    expect(archived?.status).toBe('idle')
    expect(active?.archivedAt).toBeUndefined()
    expect(active?.status).toBe('idle')
  })

  it('运行中归档不停止 driver；收尾落盘保留归档标记', async () => {
    // query 挂起直到测试放行，模拟运行中的长任务
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const { sessionId } = await createSession('proj-arc')
    await enqueueMessage({ projectId: 'proj-arc', text: '写一章', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    expect(isChatDriverActive(sessionId)).toBe(true)

    // 运行中归档：driver 照常运行（归档是列表归类，不打断任务）
    await archiveAgentSession('proj-arc', sessionId, true)
    expect(isChatDriverActive(sessionId)).toBe(true)

    releaseQuery([])
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))

    // 收尾落盘的快照里 archivedAt 仍在（内存对象已带标记，复写不丢）
    const finished = await loadSession(project, sessionId)
    expect(finished?.archivedAt).toBeTypeOf('string')
  })
})

// ---------- 测试夹具 ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-arc',
    name: 'Archive Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-arc',
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
