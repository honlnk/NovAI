import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  archiveAgentSession,
  createSession,
  deleteSession,
  enqueueMessage,
  getSession,
  renameSession,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
  _getCachedSessionIdsForTest,
} from './agent-service'
import { isChatDriverActive } from '../core/chat/session'
import { loadSession, saveSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { AgentUiEvent } from './types'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { ChatSessionState } from '../types/chat'

/**
 * 会话串行保存队列与缓存保护（数据安全计划 §3-4）的事件序回归（query mock 版）：
 * - F4：运行中的会话不被 LRU 淘汰，空闲会话照常按容量淘汰；
 * - F5：同一会话的归档/恢复/重命名/任务收尾经串行队列写盘，人为控制完成顺序后
 *   最终磁盘状态不回退；
 * - 删除排空在途保存后删文件，不复活；await 路径保存失败抛给调用方且队列不断链。
 *
 * 写盘顺序用可控闸门（holdSaves + saveGates）人为编排——事件序测试必须控制
 * 完成顺序，不依赖偶发延迟。提问/回答链路（fetch 真链路版）见
 * agent-service.question-persistence.test.ts。
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

// 可控写盘闸门：holdSaves=true 时 saveSession 挂起，直到闸门放行
let holdSaves = false
const saveGates: Array<() => void> = []

/** 按会话拒绝的名单：saveSession 对其中的 sessionId 直接抛错（失败路径用例） */
const rejectSessionIds = new Set<string>()

vi.mock('../core/chat/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/chat/session-store')>()
  return {
    ...actual,
    saveSession: vi.fn(
      async (project: ProjectSnapshot, session: ChatSessionState, options?: { touchUpdatedAt?: boolean }) => {
        if (rejectSessionIds.has(session.sessionId)) {
          throw new Error(`模拟落盘失败：${session.sessionId}`)
        }
        if (holdSaves) {
          await new Promise<void>((resolve) => saveGates.push(resolve))
        }
        return actual.saveSession(project, session, options)
      },
    ),
  }
})

const stubConfig = {
  project: { name: 'Persist Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
  },
} as unknown as ProjectConfig

/** 等到队列里的挂起写盘数达到 n（每条被 hold 的 saveSession 推一个闸门） */
async function waitForHeldSaves(n: number): Promise<void> {
  await vi.waitFor(() => expect(saveGates.length).toBeGreaterThanOrEqual(n))
}

/** 放行最早的一条挂起写盘 */
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

describe('会话串行保存队列与缓存保护（数据安全计划 §3-4）', () => {
  let project: ProjectSnapshot

  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    mockedQuery.mockResolvedValue([])
    holdSaves = false
    saveGates.length = 0
    rejectSessionIds.clear()
    project = buildProject()
    setRuntimeProject(project)
  })

  it('运行中的会话不被 LRU 淘汰；空闲会话仍按容量淘汰', async () => {
    // query 挂起模拟运行中长任务
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const first = await createSession('proj-p')
    await enqueueMessage({ projectId: 'proj-p', sessionId: first.sessionId, text: '写一章', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    expect(isChatDriverActive(first.sessionId)).toBe(true)

    // 缓存压力：再建 17 条，运行中的首条成为最旧条目（旧实现会在此被淘汰）
    const others: string[] = []
    for (let i = 0; i < 17; i += 1) {
      others.push((await createSession('proj-p')).sessionId)
    }

    const ids = _getCachedSessionIdsForTest()
    // 容量收敛在 16；运行中会话保留，被淘汰的是最旧的空闲条目
    expect(ids).toHaveLength(16)
    expect(ids).toContain(first.sessionId)
    expect(ids).not.toContain(others[0])
    expect(ids).not.toContain(others[1])
    expect(ids).toContain(others[2])

    releaseQuery([])
    await vi.waitFor(() => expect(isChatDriverActive(first.sessionId)).toBe(false))
  })

  it('LRU 压力下运行中归档再收尾：归档标记不丢、磁盘不回退（事件序）', async () => {
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const { sessionId } = await createSession('proj-p')
    await enqueueMessage({ projectId: 'proj-p', sessionId, text: '写一章', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())

    // 缓存压力：17 条新会话把运行中会话挤成最旧条目
    for (let i = 0; i < 17; i += 1) {
      await createSession('proj-p')
    }
    expect(_getCachedSessionIdsForTest()).toContain(sessionId)

    // 运行中归档，随后任务收尾（收尾的整份落盘在旧实现会覆盖掉归档标记）
    const finishEvent = subscribeEventOnce('run-finish', sessionId)
    const archived = await archiveAgentSession('proj-p', sessionId, true)
    releaseQuery([])
    await finishEvent

    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.archivedAt).toBe(archived.archivedAt)
    expect(onDisk?.messages.some((m) => m.role === 'user' && m.kind === 'text')).toBe(true)
  })

  it('人为乱序写盘：归档→任务收尾→恢复，最终磁盘状态不回退', async () => {
    let releaseQuery: (messages: []) => void = () => {}
    mockedQuery.mockImplementation(() => new Promise((resolve) => {
      releaseQuery = resolve as (messages: []) => void
    }))

    const { sessionId } = await createSession('proj-p')
    await enqueueMessage({ projectId: 'proj-p', sessionId, text: '写一章', mode: 'queue' })
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())

    // 闸门开启：先入队的归档写盘被挂起；收尾的写盘在队列里排在它后面
    //（save2 只有等 save1 完成才会真正进入写盘——这正是串行队列的语义）
    holdSaves = true
    const finishEvent = subscribeEventOnce('run-finish', sessionId)
    const archiveDone = archiveAgentSession('proj-p', sessionId, true)
    await waitForHeldSaves(1)

    // 收尾在归档写盘仍被挂起时入队（真实写盘顺序被人为逆转）
    releaseQuery([])
    releaseOneSave()
    await archiveDone
    // 收尾的写盘此刻才进入 saveSession（可能又被闸门挂住）：关闸并放行
    holdSaves = false
    releaseOneSave()
    await finishEvent

    // 恢复（撤销归档）排在收尾之后落盘：最终磁盘 = 无归档标记 + 本轮消息 + 恢复后的 updatedAt
    const restored = await archiveAgentSession('proj-p', sessionId, false)

    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.archivedAt).toBeUndefined()
    expect(onDisk?.messages.some((m) => m.role === 'user' && m.kind === 'text')).toBe(true)
    expect(onDisk?.updatedAt).toBe(restored.updatedAt)
  })

  it('重命名与归档并发：磁盘同时保留新标题与归档标记', async () => {
    const { sessionId } = await createSession('proj-p')
    await renameSession('proj-p', sessionId, '新标题')
    await archiveAgentSession('proj-p', sessionId, true)

    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.title).toBe('新标题')
    expect(onDisk?.archivedAt).toBeTypeOf('string')
  })

  it('删除与在途保存并发：排空队列后删文件，不复活；读盘不重建', async () => {
    const { sessionId } = await createSession('proj-p')

    // 重命名的保存被闸门挂起，制造「写盘在途」
    holdSaves = true
    const renaming = renameSession('proj-p', sessionId, '即将被删')
    await waitForHeldSaves(1)

    // 删除开始：必须先排空在途保存再删文件（旧实现删完后被在途写复活）
    const deleting = deleteSession('proj-p', sessionId)
    releaseOneSave()
    await renaming
    await deleting

    expect(await loadSession(project, sessionId)).toBeNull()
    expect(await getSession('proj-p', sessionId)).toBeNull()
    expect(_getCachedSessionIdsForTest()).not.toContain(sessionId)

    holdSaves = false
  })

  it('await 路径保存失败抛给调用方，队列不断链：同会话下一次保存照常落盘', async () => {
    const { sessionId } = await createSession('proj-p')

    rejectSessionIds.add(sessionId)
    await expect(renameSession('proj-p', sessionId, '失败标题')).rejects.toThrow('模拟落盘失败')
    rejectSessionIds.delete(sessionId)

    // 队列未因上一次失败断链：同一会话的下一次保存正常执行
    await expect(renameSession('proj-p', sessionId, '成功标题')).resolves.toBeTruthy()
    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.title).toBe('成功标题')
  })
})

// ---------- 内存文件系统 fixture（照 archive-session 测试） ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-p',
    name: 'Persist Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-p',
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
