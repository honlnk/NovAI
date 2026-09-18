import { describe, expect, it } from 'vitest'

import {
  SPILL_DIR,
  SPILL_HEAD_CHARS,
  SPILL_RETENTION_MS,
  SPILL_TAIL_CHARS,
  SPILL_THRESHOLD_CHARS,
  maybeSpill,
  sweepExpiredSpillFiles,
} from './spill'
import type { ProjectSnapshot } from '../../types/project'

// ---- 最小内存 FSA handle：仅实现 project-fs 读写所需的 getDirectoryHandle/getFileHandle ----

type MemoryFile = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDir = { kind: 'directory'; name: string; entries: Map<string, MemoryFile | MemoryDir> }

function createMemoryDir(name: string): MemoryDir {
  return { kind: 'directory', name, entries: new Map() }
}

function dirHandle(dir: MemoryDir): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: dir.name,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = dir.entries.get(name)
      if (current?.kind === 'directory') return dirHandle(current)
      if (current) throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next = createMemoryDir(name)
      dir.entries.set(name, next)
      return dirHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = dir.entries.get(name)
      if (current?.kind === 'file') return fileHandle(current)
      if (current) throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryFile = { kind: 'file', name, content: '', lastModified: Date.now() }
      dir.entries.set(name, next)
      return fileHandle(next)
    },
    async removeEntry(name: string) {
      if (!dir.entries.delete(name)) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
    },
    async *values() {
      for (const child of dir.entries.values()) {
        yield child.kind === 'directory' ? dirHandle(child) : fileHandle(child)
      }
    },
  } as unknown as FileSystemDirectoryHandle
}

function fileHandle(file: MemoryFile): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    async getFile() {
      return new File([file.content], file.name, { type: 'text/plain', lastModified: file.lastModified })
    },
    async createWritable() {
      return {
        async write(data: FileSystemWriteChunkType) {
          file.content = typeof data === 'string' ? data : ''
        },
        async close() {
          file.lastModified = Date.now()
        },
      } as unknown as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function createProject(): { project: ProjectSnapshot; root: MemoryDir } {
  const root = createMemoryDir('novel')
  return {
    root,
    project: { handle: dirHandle(root) } as unknown as ProjectSnapshot,
  }
}

async function readMemoryFile(root: MemoryDir, path: string): Promise<string> {
  const segments = path.split('/')
  const fileName = segments.pop()!
  let dir = root
  for (const segment of segments) {
    const next = dir.entries.get(segment)
    if (!next || next.kind !== 'directory') {
      throw new Error(`目录不存在: ${path}`)
    }
    dir = next
  }
  const file = dir.entries.get(fileName)
  if (!file || file.kind !== 'file') {
    throw new Error(`文件不存在: ${path}`)
  }
  return file.content
}

describe('maybeSpill', () => {
  it('未超阈值的结果原样通过，不落盘', async () => {
    const { project, root } = createProject()
    const content = '章'.repeat(SPILL_THRESHOLD_CHARS)

    const result = await maybeSpill(content, project)

    expect(result).toBe(content)
    expect(root.entries.has('.novel')).toBe(false)
  })

  it('超阈值的结果全文落盘，上下文里只有头尾预览 + 引用路径', async () => {
    const { project, root } = createProject()
    const content = `${'头'.repeat(SPILL_HEAD_CHARS)}${'中'.repeat(5000)}${'尾'.repeat(SPILL_TAIL_CHARS)}`

    const result = await maybeSpill(content, project)

    // 预览 = 头 + 省略标记 + 尾，显著短于全文
    expect(result.length).toBeLessThan(SPILL_THRESHOLD_CHARS)
    expect(result.startsWith('头'.repeat(SPILL_HEAD_CHARS))).toBe(true)
    expect(result.endsWith('尾'.repeat(SPILL_TAIL_CHARS))).toBe(true)
    expect(result).toContain('已省略')
    expect(result).toContain(`${SPILL_DIR}/`)

    // 全文已写入 spill 文件
    const marker = result.match(new RegExp(`${SPILL_DIR}/([\\w.-]+)\\.txt`))
    expect(marker).not.toBeNull()
    const fullPath = `${SPILL_DIR}/${marker![1]}.txt`
    await expect(readMemoryFile(root, fullPath)).resolves.toBe(content)
  })

  it('落盘失败时原样返回全文（宁可不 spill，不能丢内容）', async () => {
    const brokenProject = {
      handle: {
        getDirectoryHandle() {
          throw new Error('文件系统不可用')
        },
      },
    } as unknown as ProjectSnapshot
    const content = '字'.repeat(SPILL_THRESHOLD_CHARS + 100)

    const result = await maybeSpill(content, brokenProject)

    expect(result).toBe(content)
  })

  it('省略标记是可执行的取回指引：带路径 + ReadFile offset/limit 用法', async () => {
    const { project } = createProject()
    const content = '指'.repeat(SPILL_THRESHOLD_CHARS + 100)

    const result = await maybeSpill(content, project)

    expect(result).toContain('完整内容已存至')
    expect(result).toContain('可用 ReadFile 对该路径以 offset/limit 分段取回')
  })

  it('spill 路径自身豁免二次 spill（防御性兜底：读回 spill 文件的结果不再落盘）', async () => {
    const { project, root } = createProject()
    const content = '溢'.repeat(SPILL_THRESHOLD_CHARS + 100)

    const result = await maybeSpill(content, project, '.novel/spill/existing.txt')

    expect(result).toBe(content)
    expect(root.entries.has('.novel')).toBe(false)
    // 大小写变体同样豁免
    expect(await maybeSpill(content, project, '.NOVEL/Spill/existing.txt')).toBe(content)
  })
})

describe('sweepExpiredSpillFiles（启动清理，保留期 7 天）', () => {
  function createProjectWithSpill(files: Array<{ name: string; lastModified: number }>) {
    const { project, root } = createProject()
    const novel = createMemoryDir('.novel')
    const spill = createMemoryDir('spill')
    for (const file of files) {
      spill.entries.set(file.name, { kind: 'file', name: file.name, content: 'x', lastModified: file.lastModified })
    }
    novel.entries.set('spill', spill)
    root.entries.set('.novel', novel)
    return { project, root, spill }
  }

  it('过期文件被删除，未过期的保留', async () => {
    const now = Date.now()
    const { project, spill } = createProjectWithSpill([
      { name: 'old.txt', lastModified: now - SPILL_RETENTION_MS - 1000 },
      { name: 'fresh.txt', lastModified: now - 1000 },
      { name: 'boundary-kept.txt', lastModified: now - SPILL_RETENTION_MS + 60_000 },
    ])

    const removed = await sweepExpiredSpillFiles(project, now)

    expect(removed).toBe(1)
    expect(spill.entries.has('old.txt')).toBe(false)
    expect(spill.entries.has('fresh.txt')).toBe(true)
    expect(spill.entries.has('boundary-kept.txt')).toBe(true)
  })

  it('.novel/spill/ 不存在时安静返回 0；清理永不抛错', async () => {
    const { project } = createProject()
    await expect(sweepExpiredSpillFiles(project)).resolves.toBe(0)

    const brokenProject = {
      handle: {
        getDirectoryHandle() {
          throw new Error('文件系统不可用')
        },
      },
    } as unknown as ProjectSnapshot
    await expect(sweepExpiredSpillFiles(brokenProject)).resolves.toBe(0)
  })
})
