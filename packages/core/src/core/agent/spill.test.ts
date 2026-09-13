import { describe, expect, it } from 'vitest'

import {
  SPILL_DIR,
  SPILL_HEAD_CHARS,
  SPILL_TAIL_CHARS,
  SPILL_THRESHOLD_CHARS,
  maybeSpill,
} from './spill'
import type { ProjectSnapshot } from '../../types/project'

// ---- 最小内存 FSA handle：仅实现 project-fs 读写所需的 getDirectoryHandle/getFileHandle ----

type MemoryFile = { kind: 'file'; name: string; content: string }
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
      const next: MemoryFile = { kind: 'file', name, content: '' }
      dir.entries.set(name, next)
      return fileHandle(next)
    },
  } as unknown as FileSystemDirectoryHandle
}

function fileHandle(file: MemoryFile): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    async getFile() {
      return new File([file.content], file.name, { type: 'text/plain' })
    },
    async createWritable() {
      return {
        async write(data: FileSystemWriteChunkType) {
          file.content = typeof data === 'string' ? data : ''
        },
        async close() {},
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
})
