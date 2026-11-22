import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSnapshot } from '../types/project'
import { setRuntimeProject, removeRuntimeProject } from './project-runtime'
import { FileSaveConflictError, writeFile } from './file-service'
import { hashContent } from '../core/util/hash'

/**
 * 人工保存版本校验（正文自动保存与并发冲突交互重设计计划 §四.3 第 9 条）：
 * 磁盘更新时间之外，同时携带编辑基线正文的内容哈希——磁盘正文已不同于该基线
 * 且不是幂等写入时，即使时间戳未能识别变化也判为冲突。
 */

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

function createDirectoryHandle(entry: MemoryDirectoryEntry): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
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
      entry.entries.delete(name)
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as FileSystemDirectoryHandle
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

const PROJECT_ID = 'save-hash-test'
const A_PATH = 'chapters/a.txt'

let rootEntry: MemoryDirectoryEntry
let rootHandle: FileSystemDirectoryHandle

function seedFile(content: string, lastModified: number) {
  rootEntry.entries.set('chapters', {
    kind: 'directory',
    name: 'chapters',
    entries: new Map([['a.txt', { kind: 'file', name: 'a.txt', content, lastModified }]]),
  })
}

/** 直接改 memory 条目，模拟磁盘被外部（AI）修改 */
function setDiskContent(content: string, lastModified: number) {
  const chapters = rootEntry.entries.get('chapters')
  if (chapters?.kind !== 'directory') throw new Error('测试夹具错误：chapters 不存在')
  chapters.entries.set('a.txt', { kind: 'file', name: 'a.txt', content, lastModified })
}

beforeEach(() => {
  const now = Date.now()
  rootEntry = { kind: 'directory', name: 'novel', entries: new Map() }
  rootHandle = createDirectoryHandle(rootEntry)
  seedFile('基线正文', now)
  setRuntimeProject({
    id: PROJECT_ID,
    name: '测试项目',
    rootName: 'novel',
    handle: rootHandle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  })
})

afterEach(() => {
  removeRuntimeProject(PROJECT_ID)
  vi.useRealTimers()
})

describe('writeFile 版本 + 基线内容哈希校验', () => {
  it('基线未变（时间与内容都相符）：正常写入并返回新版本', async () => {
    const disk = await import('./file-service').then((m) => m.readFile(PROJECT_ID, A_PATH))
    const saved = await writeFile(PROJECT_ID, A_PATH, '新正文', {
      expectedUpdatedAt: disk.updatedAt,
      expectedBaseHash: hashContent('基线正文'),
    })
    expect(saved.content).toBe('新正文')
  })

  it('时间戳已识别变化：照旧判冲突', async () => {
    const disk = await import('./file-service').then((m) => m.readFile(PROJECT_ID, A_PATH))
    setDiskContent('AI 修改后的正文', Date.now() + 5000)
    await expect(
      writeFile(PROJECT_ID, A_PATH, '新正文', {
        expectedUpdatedAt: disk.updatedAt,
        expectedBaseHash: hashContent('基线正文'),
      }),
    ).rejects.toThrow(FileSaveConflictError)
  })

  it('时间戳识别不出变化（同毫秒写回）：内容哈希兜底判冲突', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1700000000000)
    const disk = await import('./file-service').then((m) => m.readFile(PROJECT_ID, A_PATH))
    // 外部在同毫秒改了内容：updatedAt 与保存所依据的版本一致，内容已不同
    setDiskContent('外部同毫秒修改', 1700000000000)
    await expect(
      writeFile(PROJECT_ID, A_PATH, '新正文', {
        expectedUpdatedAt: disk.updatedAt,
        expectedBaseHash: hashContent('基线正文'),
      }),
    ).rejects.toThrow(FileSaveConflictError)
  })

  it('幂等写入（内容与磁盘一致）：即使版本信息失配也不重写盘、不报冲突', async () => {
    const disk = await import('./file-service').then((m) => m.readFile(PROJECT_ID, A_PATH))
    // 磁盘内容 == 写入内容：幂等返回旧视图（updatedAt 不动）
    const saved = await writeFile(PROJECT_ID, A_PATH, '基线正文', {
      expectedUpdatedAt: '不相干的时间戳',
      expectedBaseHash: hashContent('别的基线'),
    })
    expect(saved.content).toBe('基线正文')
    expect(saved.updatedAt).toBe(disk.updatedAt)
  })

  it('只传内容哈希（无时间戳）：基线失配即冲突', async () => {
    setDiskContent('外部修改', Date.now() + 1000)
    await expect(
      writeFile(PROJECT_ID, A_PATH, '新正文', { expectedBaseHash: hashContent('基线正文') }),
    ).rejects.toThrow(FileSaveConflictError)
  })

  it('文件已不存在：missing 冲突', async () => {
    rootEntry.entries.delete('chapters')
    await expect(
      writeFile(PROJECT_ID, A_PATH, '新正文', { expectedBaseHash: hashContent('基线正文') }),
    ).rejects.toThrow(FileSaveConflictError)
  })
})
