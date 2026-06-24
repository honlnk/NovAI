import { afterEach, describe, expect, it } from 'vitest'

import { applyChapterOrganize, scanChaptersForOrganize } from './organize-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import type { ProjectSnapshot } from '../types/project'

/**
 * 章节整理工具测试。
 *
 * 复用项目里惯用的内存版 FileSystemDirectoryHandle（与 file-tools.test.ts / project-fs.test.ts 一致），
 * 避免依赖真实浏览器文件系统。
 */
describe('organize-service', () => {
  afterEach(() => {
    clearRuntimeProjects()
  })

  describe('scanChaptersForOrganize', () => {
    it('skips compliant chapters and counts them', async () => {
      const runtime = createRuntime({
        'chapters/第001章-火中拾婴.txt': '内容',
        'chapters/第002章-留他一命.txt': '内容',
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(0)
      expect(plan.compliantCount).toBe(2)
    })

    it('marks legacy md chapters as needing extension conversion', async () => {
      const runtime = createRuntime({
        'chapters/第001章-火中拾婴.md': '火中拾婴\n正文',
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(1)
      const item = plan.items[0]
      expect(item.reason).toBe('extension')
      expect(item.suggestedPath).toBe('chapters/第001章-火中拾婴.txt')
      expect(item.needsReview).toBe(false) // 文件名里已有标题
    })

    it('reuses the parsed number when the name has insufficient padding', async () => {
      const runtime = createRuntime({
        'chapters/第1章-火中拾婴.txt': '内容', // 补零不足，但有编号和标题
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(1)
      expect(plan.items[0].suggestedPath).toBe('chapters/第001章-火中拾婴.txt')
      expect(plan.items[0].needsReview).toBe(false)
    })

    it('falls back to first line for files without a title and marks needsReview', async () => {
      const runtime = createRuntime({
        'chapters/legacy.txt': '火中拾婴\n正文内容',
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(1)
      const item = plan.items[0]
      expect(item.needsReview).toBe(true)
      expect(item.suggestedPath).toBe('chapters/第001章-火中拾婴.txt')
    })

    it('assigns sequential numbers to files without any parseable number', async () => {
      // legacy.md 无中文编号，按排序顺序分配编号
      const runtime = createRuntime({
        'chapters/beta.md': '贝塔\n正文',
        'chapters/alpha.md': '阿尔法\n正文',
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(2)
      // localeCompare 排序：alpha < beta
      const alpha = plan.items.find((i) => i.currentName === 'alpha.md')
      const beta = plan.items.find((i) => i.currentName === 'beta.md')
      expect(alpha?.suggestedPath).toBe('chapters/第001章-阿尔法.txt')
      expect(beta?.suggestedPath).toBe('chapters/第002章-贝塔.txt')
      expect(plan.items.every((i) => i.needsReview)).toBe(true)
    })

    it('avoids number collisions: assigned numbers skip already-used ones', async () => {
      // 第001章 已被规范文件占用，无编号文件应从 002 开始分配
      const runtime = createRuntime({
        'chapters/第001章-已有.txt': '内容',
        'chapters/legacy.txt': '新章\n正文',
      })

      const plan = await scanChaptersForOrganize(runtime.projectId)

      const legacy = plan.items.find((i) => i.currentName === 'legacy.txt')
      expect(legacy?.suggestedPath).toBe('chapters/第002章-新章.txt')
    })

    it('returns empty plan when chapters directory does not exist', async () => {
      const runtime = createRuntime({})

      const plan = await scanChaptersForOrganize(runtime.projectId)

      expect(plan.items).toHaveLength(0)
      expect(plan.compliantCount).toBe(0)
    })
  })

  describe('applyChapterOrganize', () => {
    it('renames files according to the plan', async () => {
      const runtime = createRuntime({
        'chapters/legacy.md': '火中拾婴\n正文',
      })

      const results = await applyChapterOrganize(runtime.projectId, [
        { currentPath: 'chapters/legacy.md', suggestedPath: 'chapters/第001章-火中拾婴.txt' },
      ])

      expect(results).toEqual([
        { fromPath: 'chapters/legacy.md', toPath: 'chapters/第001章-火中拾婴.txt', ok: true },
      ])
      await expect(readProjectText(runtime.handle, 'chapters/第001章-火中拾婴.txt')).resolves.toBe('火中拾婴\n正文')
      await expect(readProjectText(runtime.handle, 'chapters/legacy.md')).rejects.toThrow('Not found')
    })

    it('continues on per-file failure and reports the error', async () => {
      // 第一项合法，第二项目标已存在会失败
      const runtime = createRuntime({
        'chapters/legacy.md': '内容',
        'chapters/第002章-已有.txt': '已有',
      })

      const results = await applyChapterOrganize(runtime.projectId, [
        { currentPath: 'chapters/legacy.md', suggestedPath: 'chapters/第001章-改名.txt' },
        { currentPath: 'chapters/legacy.md', suggestedPath: 'chapters/第002章-撞号.txt' }, // legacy 已被移走，源不存在
      ])

      expect(results[0].ok).toBe(true)
      expect(results[1].ok).toBe(false)
      expect(results[1].error).toBeTruthy()
    })
  })
})

// ─── 内存 fs helpers（与项目其他测试一致的惯用模式） ──────────────────────

type MemoryFileEntry = {
  kind: 'file'
  name: string
  content: string
  lastModified: number
}

type MemoryDirectoryEntry = {
  kind: 'directory'
  name: string
  entries: Map<string, MemoryEntry>
}

type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

type MemoryDirectoryHandle = FileSystemDirectoryHandle & {
  __entry: MemoryDirectoryEntry
}

function createRuntime(files: Record<string, string>): { projectId: string; handle: MemoryDirectoryHandle } {
  const handle = createMemoryDirectory('novel')

  for (const [path, content] of Object.entries(files)) {
    writeProjectTextSync(handle, path, content)
  }

  const projectId = `test-${Math.random().toString(36).slice(2)}`
  setRuntimeProject({
    id: projectId,
    name: 'Test Novel',
    rootName: 'novel',
    handle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  })

  return { projectId, handle }
}

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({
    kind: 'directory',
    name,
    entries: new Map(),
  })
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
          nextContent = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function writeProjectTextSync(rootHandle: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()
  if (!fileName) throw new Error(`Invalid file path: ${path}`)
  let current = rootHandle.__entry
  for (const segment of segments) {
    const existing = current.entries.get(segment)
    if (existing?.kind === 'file') throw new Error(`Not a directory: ${segment}`)
    if (existing?.kind === 'directory') { current = existing; continue }
    const next: MemoryDirectoryEntry = { kind: 'directory', name: segment, entries: new Map() }
    current.entries.set(segment, next)
    current = next
  }
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

async function readProjectText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()
  if (!fileName) throw new Error(`Invalid file path: ${path}`)
  let current = rootHandle
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }
  return (await current.getFileHandle(fileName).then((h) => h.getFile())).text()
}
