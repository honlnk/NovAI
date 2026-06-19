import { describe, expect, it } from 'vitest'

import { createChatSession } from './session'
import {
  saveSession,
  loadSession,
  deleteSessionFile,
  listSessionMetas,
  buildSessionFilePath,
  SESSIONS_DIR,
} from './session-store'
import type { ProjectSnapshot } from '../../types/project'

describe('chat session-store', () => {
  it('saveSession 落盘到 .novel/sessions/<sessionId>.json，刷新 updatedAt', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)
    const session = createChatSession('proj-1')
    const beforeSave = session.updatedAt

    await new Promise((r) => setTimeout(r, 5))
    await saveSession(project, session)

    const loaded = await loadSession(project, session.sessionId)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe(session.sessionId)
    // updatedAt 被 saveSession 刷新（写盘时间晚于创建时间）
    expect(loaded!.updatedAt >= beforeSave).toBe(true)
  })

  it('loadSession 在文件缺失时返回 null，不抛错', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)

    const loaded = await loadSession(project, 'nonexistent-session')
    expect(loaded).toBeNull()
  })

  it('deleteSessionFile 删除文件，且对不存在的 sessionId 静默成功', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)
    const session = createChatSession('proj-1')
    await saveSession(project, session)

    await deleteSessionFile(project, session.sessionId)
    expect(await loadSession(project, session.sessionId)).toBeNull()

    // 再次删除不抛
    await expect(deleteSessionFile(project, session.sessionId)).resolves.toBeUndefined()
  })

  it('listSessionMetas 列出所有会话并按 updatedAt 降序', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)

    const old = createChatSession('proj-1')
    old.title = '旧对话'
    old.createdAt = '2026-01-01T00:00:00.000Z'
    old.updatedAt = '2026-01-01T00:00:00.000Z'

    const recent = createChatSession('proj-1')
    recent.title = '新对话'
    recent.createdAt = '2026-02-01T00:00:00.000Z'
    // saveSession 会刷新 updatedAt 到当前时间，使 recent 排在前面

    await writeSessionRaw(project, old)
    await saveSession(project, recent)

    const metas = await listSessionMetas(project)
    expect(metas).toHaveLength(2)
    expect(metas[0].sessionId).toBe(recent.sessionId)
    expect(metas[0].title).toBe('新对话')
    expect(metas[1].sessionId).toBe(old.sessionId)
    expect(metas[1].title).toBe('旧对话')
    expect(metas[1].messageCount).toBe(0)
  })

  it('listSessionMetas 在无会话时返回空数组', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)

    const metas = await listSessionMetas(project)
    expect(metas).toEqual([])
  })

  it('listSessionMetas 跳过解析失败的损坏文件', async () => {
    const root = createMemoryDirectory('novel')
    const project = buildProject(root)

    const good = createChatSession('proj-1')
    good.title = '正常会话'
    await saveSession(project, good)

    // 写一个损坏的会话文件
    await writeRawText(project, buildSessionFilePath('corrupt-session'), '{ not valid json')

    const metas = await listSessionMetas(project)
    expect(metas).toHaveLength(1)
    expect(metas[0].sessionId).toBe(good.sessionId)
  })

  it('buildSessionFilePath / SESSIONS_DIR 路径约定正确', () => {
    expect(SESSIONS_DIR).toBe('.novel/sessions')
    expect(buildSessionFilePath('session-abc')).toBe('.novel/sessions/session-abc.json')
  })
})

// ---------- 测试夹具：内存版 FileSystemDirectoryHandle ----------

function buildProject(root: MemoryDirectoryHandle): ProjectSnapshot {
  return {
    id: 'test-project',
    name: 'Test Novel',
    rootName: 'novel',
    handle: root,
    config: {
      project: { name: 'Test Novel', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    } as ProjectSnapshot['config'],
    manifest: {
      projectId: 'test-project',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

/** 直接写一个会话对象（不经 saveSession 的 updatedAt 刷新），用于构造固定时间戳的旧会话 */
async function writeSessionRaw(project: ProjectSnapshot, session: ReturnType<typeof createChatSession>) {
  await writeRawText(project, buildSessionFilePath(session.sessionId), JSON.stringify(session, null, 2))
}

async function writeRawText(project: ProjectSnapshot, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()!
  let current = project.handle as unknown as MemoryDirectoryHandle
  for (const segment of segments) {
    let next = current.__entry.entries.get(segment)
    if (!next) {
      const dir: MemoryDirectoryEntry = { kind: 'directory', name: segment, entries: new Map() }
      current.__entry.entries.set(segment, dir)
      next = dir
    }
    current = createDirectoryHandle(next as MemoryDirectoryEntry)
  }
  current.__entry.entries.set(fileName, {
    kind: 'file',
    name: fileName,
    content,
    lastModified: Date.now(),
  })
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
