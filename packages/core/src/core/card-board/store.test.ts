import { beforeEach, describe, expect, it } from 'vitest'

import { locateCardContent, nextCardSequence, trashCardFile, writeCardFile } from './store'
import { writeProjectTextFile } from '../fs/project-fs'

/* ---------- 内存文件系统（与 plans store 测试同款内联实现） ---------- */

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

      if (current?.kind === 'directory') {
        return createDirectoryHandle(current)
      }

      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }

      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }

      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)

      if (current?.kind === 'file') {
        return createFileHandle(current)
      }

      if (current) {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }

      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }

      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
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
        async write(data: string) {
          nextContent += data
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 测试 ---------- */

let root: MemoryDirectoryHandle

function project() {
  return { handle: root }
}

const errors = {
  occupied: (path: string) => new Error(`目标文件已存在：${path}`),
  renameFailed: (from: string, to: string, reason: string) => new Error(`重命名失败：${from} → ${to}${reason}`),
}

beforeEach(() => {
  root = createMemoryDirectory('project')
})

describe('writeCardFile', () => {
  it('新建（currentPath=null）直接写入', async () => {
    await writeCardFile(project(), {
      currentPath: null,
      nextPath: 'cards/a.md',
      content: 'A',
      existingPaths: [],
      errors,
    })

    const located = await locateCardContent(project(), [{ id: 'a', sourcePath: 'cards/a.md' }], 'a')
    expect(located?.content).toBe('A')
  })

  it('同路径覆盖写（no-op 重命名）', async () => {
    await writeProjectTextFile(root, 'cards/a.md', 'old')
    await writeCardFile(project(), {
      currentPath: 'cards/a.md',
      nextPath: 'cards/a.md',
      content: 'new',
      existingPaths: ['cards/a.md'],
      errors,
    })

    const located = await locateCardContent(project(), [{ id: 'a', sourcePath: 'cards/a.md' }], 'a')
    expect(located?.content).toBe('new')
  })

  it('重命名 = 写新删旧；目标被已有卡片占用时报错', async () => {
    await writeProjectTextFile(root, 'cards/a.md', 'A')
    await writeProjectTextFile(root, 'cards/b.md', 'B')

    await expect(writeCardFile(project(), {
      currentPath: 'cards/a.md',
      nextPath: 'cards/b.md',
      content: 'A2',
      existingPaths: ['cards/a.md', 'cards/b.md'],
      errors,
    })).rejects.toThrow('目标文件已存在')

    // 原文件未被破坏
    const located = await locateCardContent(project(), [{ id: 'a', sourcePath: 'cards/a.md' }], 'a')
    expect(located?.content).toBe('A')
  })

  it('目标被未知文件（不在卡片清单）占用时同样报错', async () => {
    await writeProjectTextFile(root, 'cards/a.md', 'A')
    await writeProjectTextFile(root, 'cards/外部手建.md', 'X')

    await expect(writeCardFile(project(), {
      currentPath: 'cards/a.md',
      nextPath: 'cards/外部手建.md',
      content: 'A2',
      existingPaths: ['cards/a.md'],
      errors,
    })).rejects.toThrow('目标文件已存在')
  })

  it('删旧失败时回滚：删掉刚写入的新文件再报错', async () => {
    await writeProjectTextFile(root, 'foreshadowing/F-001-旧.md', 'OLD')

    // 让 foreshadowing 目录删除「旧文件」抛错（getDirectoryHandle 每次返回新包装，
    // 只能从内存 entry 的 entries Map 下手：delete 指定键时抛错）。
    const dirEntry = root.__entry.entries.get('foreshadowing') as MemoryDirectoryEntry
    class ThrowingDeleteMap<K, V> extends Map<K, V> {
      delete(key: K): boolean {
        if (key === 'F-001-旧.md') {
          throw new DOMException('remove failed', 'UnknownError')
        }
        return super.delete(key)
      }
    }
    dirEntry.entries = new ThrowingDeleteMap(dirEntry.entries)

    await expect(writeCardFile(project(), {
      currentPath: 'foreshadowing/F-001-旧.md',
      nextPath: 'foreshadowing/F-001-新.md',
      content: 'NEW',
      existingPaths: ['foreshadowing/F-001-旧.md'],
      errors,
    })).rejects.toThrow('重命名失败')

    // 新文件已被回滚清理，只剩旧文件
    expect(Object.keys(collectFiles())).toEqual(['foreshadowing/F-001-旧.md'])
  })
})

describe('trashCardFile', () => {
  it('写 trash 副本后删原文件', async () => {
    await writeProjectTextFile(root, 'cards/a.md', 'A')
    const trashPath = await trashCardFile(project(), 'cards/a.md', 'A')

    expect(trashPath.startsWith('.novel/trash/')).toBe(true)
    expect(Object.keys(collectFiles())).toEqual([trashPath])
  })
})

describe('nextCardSequence', () => {
  it('现有序号最大值 + 1；无序号从 1 开始', () => {
    const extract = (path: string) => {
      const match = /^cards\/F-(\d+)-/.exec(path)
      return match ? Number(match[1]) : null
    }

    expect(nextCardSequence([], extract)).toBe(1)
    expect(nextCardSequence(['cards/F-001-a.md', 'cards/F-003-b.md', 'cards/外部.md'], extract)).toBe(4)
  })
})

function collectFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  collectSync(root.__entry, '')
  return files

  function collectSync(entry: MemoryDirectoryEntry, prefix: string) {
    for (const [name, child] of entry.entries) {
      if (child.kind === 'directory') {
        collectSync(child, `${prefix}${name}/`)
      } else {
        files[`${prefix}${name}`] = child.content
      }
    }
  }
}
