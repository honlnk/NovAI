import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearRuntimeProjects,
  setRuntimeProject,
} from './project-runtime'
import {
  ChapterNumberTakenError,
  InvalidChapterNumberError,
  createProjectChapter,
  listProjectChapters,
} from './chapter-service'
import { refreshFiles } from './file-service'
import { readProjectTextFile, writeProjectTextFile } from '../core/fs/project-fs'
import type { ProjectSnapshot } from '../types/project'

/* ---------- 内存文件系统（与其他服务测试同款内联实现） ---------- */

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

      const next: MemoryDirectoryEntry = {
        kind: 'directory',
        name,
        entries: new Map(),
      }
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

      const next: MemoryFileEntry = {
        kind: 'file',
        name,
        content: '',
        lastModified: Date.now(),
      }
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
        yield child.kind === 'directory'
          ? createDirectoryHandle(child)
          : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, {
        type: 'text/plain',
        lastModified: entry.lastModified,
      })
    },
    async createWritable() {
      let nextContent = ''

      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob
              ? await data.text()
              : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function createProjectSnapshot(id: string): ProjectSnapshot {
  const root = createDirectoryHandle({
    kind: 'directory',
    name: `${id}-root`,
    entries: new Map(),
  })

  return {
    id,
    name: id,
    rootName: root.name,
    handle: root as FileSystemDirectoryHandle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {
      id,
      name: id,
      updatedAt: '',
      chapterCount: 0,
      elementCount: 0,
      wordCount: 0,
    },
  }
}

/* ---------- 测试 ---------- */

const PROJECT_A = 'chapter-service-test-a'
const PROJECT_B = 'chapter-service-test-b'

let snapshotA: ProjectSnapshot
let snapshotB: ProjectSnapshot

beforeEach(() => {
  clearRuntimeProjects()
  snapshotA = createProjectSnapshot(PROJECT_A)
  snapshotB = createProjectSnapshot(PROJECT_B)
  setRuntimeProject(snapshotA)
  setRuntimeProject(snapshotB)
})

afterEach(() => {
  clearRuntimeProjects()
})

async function seedChapters(
  snapshot: ProjectSnapshot,
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    await writeProjectTextFile(snapshot.handle, path, `（${path} 的正文）`)
  }
}

describe('listProjectChapters', () => {
  it('空项目：空目录不抛错', async () => {
    const catalog = await listProjectChapters(PROJECT_A)
    expect(catalog.entries).toEqual([])
    expect(catalog.maxNumber).toBeNull()
  })

  it('读取运行时树：含卷目录、排序与重复章号标记', async () => {
    await seedChapters(snapshotA, [
      'chapters/第一卷/第003章-风雨.txt',
      'chapters/第001章-东宫听讼.txt',
      'chapters/第001章-东宫听讼-草稿副本.txt',
    ])
    // 让运行时树反映磁盘（生产路径由打开/刷新流程维护，测试手动重扫）
    await refreshFiles(PROJECT_A)

    const catalog = await listProjectChapters(PROJECT_A)
    expect(catalog.entries.map(entry => entry.number)).toEqual([1, 1, 3])
    expect(catalog.duplicateNumbers).toEqual(new Set([1]))
    expect(catalog.maxNumber).toBe(3)
  })
})

describe('createProjectChapter', () => {
  it('空项目：在 chapters/ 根创建规范空章节，标题留空用「未命名」', async () => {
    const result = await createProjectChapter(PROJECT_A, { chapterNumber: 1, title: null })

    expect(result.entry).toMatchObject({
      number: 1,
      title: '未命名',
      path: 'chapters/第001章-未命名.txt',
    })

    const content = await readProjectTextFile(snapshotA.handle, 'chapters/第001章-未命名.txt')
    expect(content).toBe('')

    // 成功后运行时树立即包含新章节（后续服务读取不吃陈旧）
    expect((await listProjectChapters(PROJECT_A)).entries.map(entry => entry.path))
      .toEqual(['chapters/第001章-未命名.txt'])
  })

  it('落点跟随最新章所在卷；编号宽度跟随既有最大章号', async () => {
    await seedChapters(snapshotA, [
      'chapters/第一卷/第009章-旧章.txt',
      'chapters/第002章-开篇.txt',
    ])

    const result = await createProjectChapter(PROJECT_A, { chapterNumber: 10, title: '新篇章' })

    expect(result.entry).toMatchObject({
      directory: '第一卷',
      path: 'chapters/第一卷/第010章-新篇章.txt',
    })
  })

  it('标题清理非法字符；超过 999 章自然 4 位编号', async () => {
    await seedChapters(snapshotA, ['chapters/第999章-终.txt'])

    const result = await createProjectChapter(PROJECT_A, { chapterNumber: 1000, title: '番外:补完' })
    expect(result.entry.fileName).toBe('第1000章-番外补完.txt')
  })

  it('章号被占用：抛 ChapterNumberTakenError 并携带占用条目（含卷内重号）', async () => {
    await seedChapters(snapshotA, [
      'chapters/第一卷/第003章-风雨.txt',
      'chapters/第003章-重复.txt',
    ])
    await refreshFiles(PROJECT_A)

    const error = await createProjectChapter(PROJECT_A, { chapterNumber: 3, title: '撞号' })
      .catch(thrown => thrown)

    expect(error).toBeInstanceOf(ChapterNumberTakenError)
    expect((error as ChapterNumberTakenError).existing).toHaveLength(2)
    // 撞号不落盘：目录仍只有已 seeding 的两章
    expect((await listProjectChapters(PROJECT_A)).entries).toHaveLength(2)
  })

  it('非正整数章号：抛 InvalidChapterNumberError，不触盘', async () => {
    for (const invalid of [0, -1, 2.5, Number.NaN]) {
      await expect(createProjectChapter(PROJECT_A, { chapterNumber: invalid }))
        .rejects.toBeInstanceOf(InvalidChapterNumberError)
    }
    expect((await listProjectChapters(PROJECT_A)).entries).toEqual([])
  })

  it('项目隔离：A 项目建章不影响 B 项目目录', async () => {
    await seedChapters(snapshotB, ['chapters/第005章-乙项目章.txt'])
    await refreshFiles(PROJECT_B)

    await createProjectChapter(PROJECT_A, { chapterNumber: 1 })

    const catalogA = await listProjectChapters(PROJECT_A)
    const catalogB = await listProjectChapters(PROJECT_B)
    expect(catalogA.entries.map(entry => entry.fileName)).toEqual(['第001章-未命名.txt'])
    expect(catalogB.entries.map(entry => entry.fileName)).toEqual(['第005章-乙项目章.txt'])
  })
})
