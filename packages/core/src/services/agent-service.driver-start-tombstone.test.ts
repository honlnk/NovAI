import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  deleteSession,
  enqueueMessage,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { isChatDriverActive } from '../core/chat/session'
import { saveSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent } from './types'

/**
 * 删除与在途唤醒并发的事件序回归（第三波 F12 的 core 防御面）：
 * enqueueMessage 的唤醒在 driver-start 之前要组装 turn 输入（读大纲等）——
 * 在这个窗口内删除会话（墓碑已立、文件已删），随后 driver 才 start：
 * 不得广播 run-start 复活 UI 运行标记，收尾也不得落盘复活会话文件。
 * 对照组证明正常唤醒仍广播 run-start（不是 mock 把事件藏掉了）。
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

// 可控闸门：下一次 buildSessionTurnInput 里的 readOutlinePrompt 挂起，
// 把唤醒卡在 wakeChatDriver / driver-start 之前
let holdNextOutline = false
const outlineGates: Array<() => void> = []

vi.mock('../core/fs/project-fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/fs/project-fs')>()
  const actualReadOutlinePrompt = actual.readOutlinePrompt
  return {
    ...actual,
    readOutlinePrompt: vi.fn(async (...args: Parameters<typeof actualReadOutlinePrompt>) => {
      if (holdNextOutline) {
        holdNextOutline = false
        await new Promise<void>((resolve) => outlineGates.push(resolve))
      }
      return actualReadOutlinePrompt(...args)
    }),
  }
})

const mockedQuery = vi.mocked(query)
const mockedSaveSession = vi.mocked(saveSession)

const stubConfig = {
  project: { name: 'Tombstone Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
  },
} as unknown as ProjectConfig

describe('删除与在途唤醒并发（driver-start 前删除）', () => {
  let project: ProjectSnapshot
  let events: AgentUiEvent[]
  let unsubscribe: () => void

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset().mockResolvedValue([])
    mockedSaveSession.mockClear()
    holdNextOutline = false
    outlineGates.length = 0
    project = buildProject()
    setRuntimeProject(project)
    await createSession('proj-tomb')
    events = []
    unsubscribe = subscribeAgentEvents((event) => events.push(event))
  })

  it('driver-start 前已删除：不广播 run-start，收尾不落盘不复活', async () => {
    holdNextOutline = true
    const { sessionId } = await enqueueMessage({
      projectId: 'proj-tomb',
      text: '写一章',
      mode: 'queue',
    })
    // 唤醒已发起但卡在 driver-start 之前的输入组装窗口
    await vi.waitFor(() => expect(outlineGates.length).toBe(1))
    expect(events.filter((event) => event.type === 'run-start')).toHaveLength(0)

    const saveCallsBeforeDelete = mockedSaveSession.mock.calls.length
    await deleteSession('proj-tomb', sessionId)

    // 放行：wakeChatDriver 继续，driver-start 命中墓碑（driver 本身照常运行到收敛）
    outlineGates[0]()
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))

    const types = events.map((event) => event.type)
    expect(types).not.toContain('run-start')
    expect(types).not.toContain('run-finish')
    expect(types).not.toContain('run-error')
    // 收尾不落盘（会话文件不复活）
    expect(mockedSaveSession.mock.calls.length).toBe(saveCallsBeforeDelete)

    unsubscribe()
  })

  it('对照组：未删除的正常唤醒仍广播 run-start', async () => {
    holdNextOutline = true
    const { sessionId } = await enqueueMessage({
      projectId: 'proj-tomb',
      text: '写一章',
      mode: 'queue',
    })
    await vi.waitFor(() => expect(outlineGates.length).toBe(1))
    outlineGates[0]()
    // 先确认 driver 真正启动（否则「未激活」的即时读数会让等待空过）
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))

    expect(events.filter((event) => event.type === 'run-start' && event.sessionId === sessionId)).toHaveLength(1)

    unsubscribe()
  })
})

// ---------- 测试夹具（内存目录句柄，与 delete-session 测试同型） ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-tomb',
    name: 'Tombstone Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-tomb',
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
