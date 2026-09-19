import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  deleteSession,
  enqueueMessage,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { isChatDriverActive } from '../core/chat/session'
import { loadSession, saveSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent } from './types'

/**
 * 修复批回归：运行中删除会话——driver 被停、收尾不再落盘（文件不复活）、不广播。
 */

vi.mock('../core/agent/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/agent/query')>()
  return {
    ...actual,
    query: vi.fn(),
  }
})

vi.mock('../core/chat/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/chat/session-store')>()
  return {
    ...actual,
    saveSession: vi.fn(actual.saveSession),
  }
})

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

const mockedQuery = vi.mocked(query)
const mockedSaveSession = vi.mocked(saveSession)

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

describe('运行中删除会话', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    mockedSaveSession.mockClear()
    project = buildProject()
    setRuntimeProject(project)
    await createSession('proj-del')
  })

  it('deleteSession 停 driver；收尾不再 saveSession（文件不复活）也不广播 run-finish', async () => {
    // query 挂起直到测试放行，模拟运行中的长任务
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const events: AgentUiEvent[] = []
    const unsubscribe = subscribeAgentEvents((event) => events.push(event))

    const { sessionId } = await enqueueMessage({
      projectId: 'proj-del',
      text: '写一章',
      mode: 'queue',
    })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    expect(isChatDriverActive(sessionId)).toBe(true)

    // 运行中删除：driver 停止 + 文件删除
    const saveCallsBeforeDelete = mockedSaveSession.mock.calls.length
    await deleteSession('proj-del', sessionId)
    expect(isChatDriverActive(sessionId)).toBe(true) // 停止是优雅的：当前 turn 收尾后才收敛

    // 放行 query → turn 正常结束 → driver 收敛 → 收尾回调命中墓碑
    releaseQuery([])
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))

    // 删除后不再有任何 saveSession（会话文件不复活）
    expect(mockedSaveSession.mock.calls.length).toBe(saveCallsBeforeDelete)
    // 同一份内存 handle 上读：文件确实没被收尾落盘复活
    const revived = await loadSession(project, sessionId)
    expect(revived).toBeNull()

    // 收尾静默：不广播 run-finish / run-error / file-changed
    const types = events.map((event) => event.type)
    expect(types).not.toContain('run-finish')
    expect(types).not.toContain('run-error')
    expect(types).not.toContain('file-changed')

    unsubscribe()
  })
})

// ---------- 测试夹具 ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-del',
    name: 'Delete Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-del',
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
