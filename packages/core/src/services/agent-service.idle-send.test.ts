import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { isChatDriverActive } from '../core/chat/session'
import { loadSession, saveSession } from '../core/chat/session-store'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent, QueuedMessageView } from './types'

/**
 * 发送消息的呈现归属回归（对照 dsh：发送那一刻按 driver 状态决定去向——
 * 空闲发送直入对话，只有运行中发送才进排队栏）。
 *
 * enqueueMessage 落盘后、driver 取走前有一段唤醒窗口（装配 turn 输入要读文件）。
 * 空闲发送的消息在这段窗口里必然马上被取走开跑，不得以「排队」形态广播——
 * 否则排队栏会先闪出这条消息、再跳成对话气泡（手机上 I/O 慢，闪得尤其久）。
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

vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test-${Math.random()}`,
  writeAgentLog: vi.fn(),
}))

// 可控闸门：把下一次唤醒卡在 driver-start 之前（turn 输入装配窗口）
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

const PROJECT_ID = 'proj-idle-send'

const stubConfig = {
  project: { name: 'Idle Send Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
  },
} as unknown as ProjectConfig

describe('发送消息的呈现归属：空闲直入对话，运行中才排队', () => {
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
    await createSession(PROJECT_ID)
    events = []
    unsubscribe = subscribeAgentEvents((event) => events.push(event))
  })

  /** 指定会话收到的排队快照序列（每份是当时的队列文本）。 */
  const queueSnapshots = (sessionId: string) => events
    .filter((event): event is Extract<AgentUiEvent, { type: 'queue-updated' }> =>
      event.type === 'queue-updated' && event.sessionId === sessionId)
    .map((event) => event.queue)

  it('空闲发送：唤醒窗口内不广播排队快照；落盘仍先于唤醒，取走后直接出对话气泡', async () => {
    holdNextOutline = true
    const { sessionId } = await enqueueMessage({ projectId: PROJECT_ID, text: '写一章', mode: 'queue' })
    // 唤醒已发起、卡在 driver-start 之前
    await vi.waitFor(() => expect(outlineGates.length).toBe(1))

    // 耐久入队先于唤醒不变：消息此刻已在磁盘上的收件箱里（刷新后队列还在）
    const onDisk = await loadSession(project, sessionId)
    expect(onDisk?.inbox?.nextTurn.map((message) => message.text)).toEqual(['写一章'])
    // 这段窗口里没有任何快照把它报成「排队」——排队栏不会闪
    expect(queueSnapshots(sessionId)).toEqual([])

    outlineGates[0]()
    // 先确认 driver 真正启动（否则「未激活」的即时读数会让等待空过），再等它收敛
    await vi.waitFor(() => expect(mockedQuery).toHaveBeenCalled())
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))

    expect(events.map((event) => event.type)).toContain('run-start')
    const userBubbles = events.filter((event) => event.type === 'message'
      && event.message.role === 'user' && event.message.kind === 'text')
    expect(userBubbles.map((event) => event.message.kind === 'text' && event.message.text))
      .toEqual(['写一章'])
    // driver 首批取走后的收件箱快照照常广播（队列清空）
    expect(queueSnapshots(sessionId).at(-1)).toEqual([])
  })

  it('运行中发送：仍广播排队快照（消息确实要等当前 turn 结束）', async () => {
    let releaseFirstRun: (() => void) | undefined
    let queryCalls = 0
    mockedQuery.mockImplementation(async () => {
      queryCalls += 1
      if (queryCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirstRun = resolve })
      }
      return []
    })

    const { sessionId } = await enqueueMessage({ projectId: PROJECT_ID, text: '第一条', mode: 'queue' })
    await vi.waitFor(() => expect(releaseFirstRun).toBeTypeOf('function'))
    expect(isChatDriverActive(sessionId)).toBe(true)

    await enqueueMessage({ projectId: PROJECT_ID, sessionId, text: '第二条', mode: 'queue' })

    const latest: QueuedMessageView[] | undefined = queueSnapshots(sessionId).at(-1)
    expect(latest?.map((message) => message.text)).toEqual(['第二条'])
    expect(latest?.[0].placement).toBe('queued')

    releaseFirstRun!()
    await vi.waitFor(() => expect(isChatDriverActive(sessionId)).toBe(false))
    expect(queryCalls).toBe(2)
  })

  it('空闲发送但唤醒失败：消息回到排队快照（仍可见、不静默消失），错误不外溢', async () => {
    // 去掉 prompts/system.md：装配 turn 输入时 readSystemPrompt 抛错，唤醒在 driver-start 前失败
    await project.handle.removeEntry('prompts')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { sessionId } = await enqueueMessage({ projectId: PROJECT_ID, text: '写一章', mode: 'queue' })
    await vi.waitFor(() => expect(queueSnapshots(sessionId).at(-1)?.map((message) => message.text))
      .toEqual(['写一章']))

    expect(events.map((event) => event.type)).not.toContain('run-start')
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

// ---------- 测试夹具（内存目录句柄，与 driver-start 墓碑测试同型） ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: PROJECT_ID,
    name: 'Idle Send Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: PROJECT_ID,
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
