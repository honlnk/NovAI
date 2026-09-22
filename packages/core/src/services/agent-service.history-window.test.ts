import { beforeEach, describe, expect, it } from 'vitest'

import {
  getSession,
  loadOlderMessages,
  _clearSessionCacheForTest,
} from './agent-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { buildSessionFilePath } from '../core/chat/session-store'
import type { ChatMessage, ChatSessionState, FileChangeRecord } from '../types/chat'
import type { ProjectSnapshot } from '../types/project'

/**
 * 历史分页窗口（historyStart / loadOlderMessages）测试：
 * - getSession 传 tailMessages 只回尾部窗口，historyStart 标记窗口起点（全量下标）
 * - loadOlderMessages 以 before 下标为游标向前取页，边界钳制
 * - 窗口内 change-summary 仍从完整账本解析 changes（切片不丢账本上下文）
 *
 * 消息 id 是随机串无序号，分页游标依赖 messages 数组 append-only 的下标稳定性；
 * 测试用确定性 id（m-<下标>）以便断言切片边界。
 * 文件系统用内存 handle（会话从盘加载走它），不触发 LLM。
 */

const TOTAL = 250

function buildTextMessage(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    text: `第 ${index} 条消息`,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(),
  }
}

function buildLedgerRecord(): FileChangeRecord {
  return {
    id: 'rec-1',
    runId: 'run-1',
    at: '2026-01-01T00:00:00.000Z',
    change: { type: 'created', path: 'chapters/第001章-初遇.txt' },
    diff: { oldText: '', newText: '第一章正文', linesAdded: 1, linesRemoved: 0 },
  }
}

/** 250 条文本消息 + 一条落在尾部窗口内的 change-summary（下标 200），账本含对应记录 */
function buildSessionState(): ChatSessionState {
  const messages: ChatMessage[] = []
  for (let index = 0; index < TOTAL; index += 1) {
    messages.push(buildTextMessage(index))
  }
  messages[200] = {
    id: 'm-200',
    role: 'system',
    kind: 'change-summary',
    runId: 'run-1',
    createdAt: new Date(1700000000000 + 200 * 1000).toISOString(),
  }
  return {
    sessionId: 's-history',
    projectId: 'proj-history',
    messages,
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    changeLedger: [buildLedgerRecord()],
    title: '长会话',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('会话历史分页窗口', () => {
  beforeEach(() => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    const root = createMemoryDirectory('novel')
    seedFile(root, buildSessionFilePath('s-history'), JSON.stringify(buildSessionState(), null, 2))
    setRuntimeProject(buildProject(root))
  })

  it('getSession 不传参：返回全量，无 historyStart', async () => {
    const view = await getSession('proj-history', 's-history')
    expect(view).not.toBeNull()
    expect(view!.messages).toHaveLength(TOTAL)
    expect(view!.historyStart).toBeUndefined()
  })

  it('getSession tailMessages=100：只回尾部 100 条，historyStart 指向窗口起点', async () => {
    const view = await getSession('proj-history', 's-history', { tailMessages: 100 })
    expect(view!.messages).toHaveLength(100)
    expect(view!.historyStart).toBe(150)
    expect(view!.messages[0].id).toBe('m-150')
    expect(view!.messages[99].id).toBe('m-249')
  })

  it('getSession tailMessages 超过总数：返回全量且无 historyStart', async () => {
    const view = await getSession('proj-history', 's-history', { tailMessages: 999 })
    expect(view!.messages).toHaveLength(TOTAL)
    expect(view!.historyStart).toBeUndefined()
  })

  it('窗口内 change-summary 从完整账本解析并聚合（含片段 diff）', async () => {
    const view = await getSession('proj-history', 's-history', { tailMessages: 100 })
    const summary = view!.messages.find((message) => message.kind === 'change-summary')
    expect(summary).toBeDefined()
    if (summary?.kind !== 'change-summary') throw new Error('unreachable')
    expect(summary.files).toHaveLength(1)
    expect(summary.files[0]).toMatchObject({ path: 'chapters/第001章-初遇.txt', status: 'created' })
    expect(summary.files[0].records[0].diff?.newText).toBe('第一章正文')
  })

  it('loadOlderMessages：以 before 为游标向前取一页', async () => {
    const page = await loadOlderMessages('proj-history', 's-history', { before: 150, count: 100 })
    expect(page).not.toBeNull()
    expect(page!.start).toBe(50)
    expect(page!.messages).toHaveLength(100)
    expect(page!.messages[0].id).toBe('m-50')
    expect(page!.messages[99].id).toBe('m-149')
  })

  it('loadOlderMessages：不足一页时钳制到开头（start=0）', async () => {
    const page = await loadOlderMessages('proj-history', 's-history', { before: 50, count: 100 })
    expect(page!.start).toBe(0)
    expect(page!.messages).toHaveLength(50)
    expect(page!.messages[0].id).toBe('m-0')
    expect(page!.messages[49].id).toBe('m-49')
  })

  it('loadOlderMessages：before=0 返回空页（没有更早历史）', async () => {
    const page = await loadOlderMessages('proj-history', 's-history', { before: 0, count: 100 })
    expect(page!.start).toBe(0)
    expect(page!.messages).toEqual([])
  })

  it('loadOlderMessages：before 超过总数时钳制到末尾', async () => {
    const page = await loadOlderMessages('proj-history', 's-history', { before: 999, count: 100 })
    expect(page!.start).toBe(150)
    expect(page!.messages).toHaveLength(100)
    expect(page!.messages[0].id).toBe('m-150')
  })

  it('loadOlderMessages：会话不存在返回 null', async () => {
    const page = await loadOlderMessages('proj-history', 's-ghost', { before: 10, count: 100 })
    expect(page).toBeNull()
  })
})

// ---------- 测试夹具：内存版 FileSystemDirectoryHandle（与 session-store.test.ts 同构） ----------

function buildProject(root: MemoryDirectoryHandle): ProjectSnapshot {
  return {
    id: 'proj-history',
    name: 'History Test',
    rootName: 'novel',
    handle: root,
    config: {
      project: { name: 'History Test', createdAt: '', updatedAt: '' },
    } as ProjectSnapshot['config'],
    manifest: {
      projectId: 'proj-history',
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
        async abort() {},
      }
    },
  } as unknown as FileSystemFileHandle
}
