import { beforeEach, describe, expect, it } from 'vitest'

import {
  JsonLedgerConflictError,
  JsonLedgerCorruptError,
  readJsonLedger,
  writeJsonLedger,
} from './json-ledger'
import { writeProjectTextFile } from '../fs/project-fs'
import { hashContent } from '../util/hash'

/* ---------- 内存文件系统（与 card-board store 测试同款内联实现） ---------- */

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

interface TestLedger {
  version: 1
  items: string[]
}

function revive(raw: unknown): TestLedger {
  if (!recordLike(raw) || raw.version !== 1 || !Array.isArray(raw.items)) {
    throw new Error('账本根结构不合法或版本不识别')
  }
  return raw as TestLedger
}

function recordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

let root: MemoryDirectoryHandle

function project() {
  return { handle: root }
}

const PATH = 'elements/relations.json'

beforeEach(() => {
  root = createMemoryDirectory('project')
})

describe('readJsonLedger', () => {
  it('文件不存在返回 null（空账本语义，旧项目零迁移）', async () => {
    expect(await readJsonLedger({ project: project(), path: PATH, revive })).toBeNull()
  })

  it('合法账本返回对象与内容哈希', async () => {
    const content = JSON.stringify({ version: 1, items: ['a'] })
    await writeProjectTextFile(root, PATH, content)

    const result = await readJsonLedger({ project: project(), path: PATH, revive })
    expect(result?.ledger).toEqual({ version: 1, items: ['a'] })
    expect(result?.contentHash).toBe(hashContent(content))
  })

  it('JSON 解析失败抛损坏错误并携带原始内容', async () => {
    await writeProjectTextFile(root, PATH, '{oops')

    const error = await readJsonLedger({ project: project(), path: PATH, revive }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonLedgerCorruptError)
    expect((error as JsonLedgerCorruptError).raw).toBe('{oops')
    expect((error as JsonLedgerCorruptError).path).toBe(PATH)
  })

  it('根结构不合法（版本不识别）抛损坏错误', async () => {
    await writeProjectTextFile(root, PATH, JSON.stringify({ version: 2, items: [] }))

    await expect(readJsonLedger({ project: project(), path: PATH, revive })).rejects.toBeInstanceOf(JsonLedgerCorruptError)
  })
})

describe('writeJsonLedger', () => {
  it('expectedContentHash=null 新建写入，返回内容哈希', async () => {
    const { contentHash } = await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: [] },
      expectedContentHash: null,
    })

    const read = await readJsonLedger({ project: project(), path: PATH, revive })
    expect(read?.ledger).toEqual({ version: 1, items: [] })
    expect(read?.contentHash).toBe(contentHash)
  })

  it('expectedContentHash=null 但文件已存在 → 冲突（新建不得覆盖）', async () => {
    await writeProjectTextFile(root, PATH, JSON.stringify({ version: 1, items: ['x'] }))

    const error = await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: [] },
      expectedContentHash: null,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonLedgerConflictError)
    expect((error as JsonLedgerConflictError).currentContentHash).toBe(hashContent(JSON.stringify({ version: 1, items: ['x'] })))
  })

  it('expectedContentHash 与磁盘不一致 → 冲突并携带磁盘当前哈希', async () => {
    await writeProjectTextFile(root, PATH, JSON.stringify({ version: 1, items: ['外部修改'] }))

    const staleHash = hashContent(JSON.stringify({ version: 1, items: [] }))
    const error = await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: ['新'] },
      expectedContentHash: staleHash,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonLedgerConflictError)
    expect((error as JsonLedgerConflictError).currentContentHash).toBe(hashContent(JSON.stringify({ version: 1, items: ['外部修改'] })))
  })

  it('expectedContentHash 与磁盘一致 → 写入成功', async () => {
    const first = await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: [] },
      expectedContentHash: null,
    })

    await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: ['a'] },
      expectedContentHash: first.contentHash,
    })

    const read = await readJsonLedger({ project: project(), path: PATH, revive })
    expect(read?.ledger).toEqual({ version: 1, items: ['a'] })
  })

  it('预期哈希非空但文件已不存在 → 冲突（missing 语义）', async () => {
    const error = await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: [] },
      expectedContentHash: 'h0',
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonLedgerConflictError)
    expect((error as JsonLedgerConflictError).currentContentHash).toBeNull()
  })

  it("expectedContentHash='force' 跳过版本检查（仅损坏重置出口使用）", async () => {
    await writeProjectTextFile(root, PATH, 'corrupt!!!')

    await writeJsonLedger({
      project: project(),
      path: PATH,
      ledger: { version: 1, items: [] },
      expectedContentHash: 'force',
    })

    const read = await readJsonLedger({ project: project(), path: PATH, revive })
    expect(read?.ledger).toEqual({ version: 1, items: [] })
  })
})
