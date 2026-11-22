import { beforeEach, describe, expect, it } from 'vitest'

import {
  ELEMENT_ID_PATTERN,
  buildElementReferenceIndex,
  ensureElementId,
  generateElementId,
  resolveElementById,
  searchElementEntries,
} from './reference-index'
import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'

import type { ProjectSnapshot, TreeNode } from '../../types/project'

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

function elementFile(options: { id?: string; type?: string; name: string; summary?: string; body?: string }): string {
  const frontmatter = [
    '---',
    `id: ${options.id ?? ''}`,
    `type: ${options.type ?? 'character'}`,
    `name: ${options.name}`,
    `summary: ${options.summary ?? ''}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + (options.body ?? `# ${options.name}\n\n正文`)
}

/** 扁平树（collectReferencePaths 支持嵌套，扁平文件节点列表等价覆盖路径收集职责）。 */
function flatTree(paths: string[]): TreeNode[] {
  return paths.map((path) => ({
    kind: 'file',
    name: path.split('/').pop() ?? path,
    path,
  }))
}

let root: MemoryDirectoryHandle
let treePaths: string[]

function project(): ProjectSnapshot {
  return {
    handle: root,
    tree: flatTree(treePaths),
  } as unknown as ProjectSnapshot
}

async function writeFile(path: string, content: string): Promise<void> {
  await writeProjectTextFile(root, path, content)
  if (!treePaths.includes(path)) {
    treePaths.push(path)
  }
}

beforeEach(() => {
  root = createMemoryDirectory('project')
  treePaths = []
})

describe('buildElementReferenceIndex', () => {
  it('收集六类目录的 .md（含嵌套子目录），排除非 .md 与 elements 根级文件', async () => {
    await writeFile('elements/characters/林澜.md', elementFile({ name: '林澜', type: 'character', summary: '主角' }))
    await writeFile('elements/locations/北境.md', elementFile({ name: '北境', type: 'location' }))
    await writeFile('elements/characters/配角/老周.md', elementFile({ name: '老周', type: 'character' }))
    await writeFile('elements/characters/笔记.txt', '不是要素')
    await writeFile('elements/relations.json', '{}')

    const index = await buildElementReferenceIndex(project())
    expect(index.entries.map((entry) => entry.name)).toEqual(['林澜', '老周', '北境'])
    expect(index.issues).toEqual([])
  })

  it('frontmatter 缺 id → 条目 id 为空串（等待懒分配）', async () => {
    await writeFile('elements/characters/林澜.md', elementFile({ name: '林澜' }))
    const index = await buildElementReferenceIndex(project())
    expect(index.entries[0].id).toBe('')
  })

  it('重复 id 报 issue 且条目全部保留（不静默合并）', async () => {
    await writeFile('elements/characters/林澜.md', elementFile({ name: '林澜', id: 'ELM-dupe00000' }))
    await writeFile('elements/locations/北境.md', elementFile({ name: '北境', type: 'location', id: 'ELM-dupe00000' }))

    const index = await buildElementReferenceIndex(project())
    expect(index.entries).toHaveLength(2)
    expect(index.issues).toEqual([
      {
        kind: 'duplicate-id',
        id: 'ELM-dupe00000',
        sourcePaths: ['elements/characters/林澜.md', 'elements/locations/北境.md'],
      },
    ])
  })

  it('按「类型分组序 + 名称序」稳定排序', async () => {
    await writeFile('elements/worldbuilding/规则.md', elementFile({ name: '规则', type: 'worldbuilding' }))
    await writeFile('elements/characters/乙.md', elementFile({ name: '乙' }))
    await writeFile('elements/characters/甲.md', elementFile({ name: '甲' }))
    await writeFile('elements/locations/北境.md', elementFile({ name: '北境', type: 'location' }))

    const index = await buildElementReferenceIndex(project())
    expect(index.entries.map((entry) => entry.type)).toEqual(['character', 'character', 'location', 'worldbuilding'])
    expect(index.entries.map((entry) => entry.name)).toEqual(['乙', '甲', '北境', '规则'])
  })
})

describe('resolveElementById', () => {
  it('resolved / missing / ambiguous 三态', async () => {
    await writeFile('elements/characters/林澜.md', elementFile({ name: '林澜', id: 'ELM-ok0000000' }))
    await writeFile('elements/characters/影武者.md', elementFile({ name: '影武者', id: 'ELM-bad0000000' }))
    await writeFile('elements/locations/北境.md', elementFile({ name: '北境', type: 'location', id: 'ELM-bad0000000' }))
    const index = await buildElementReferenceIndex(project())

    expect(resolveElementById(index, 'ELM-ok0000000')).toEqual({
      status: 'resolved',
      entry: expect.objectContaining({ name: '林澜', sourcePath: 'elements/characters/林澜.md' }),
    })
    expect(resolveElementById(index, 'ELM-none000000')).toEqual({ status: 'missing', id: 'ELM-none000000' })
    expect(resolveElementById(index, 'ELM-bad0000000')).toEqual({
      status: 'ambiguous',
      id: 'ELM-bad0000000',
      sourcePaths: ['elements/characters/影武者.md', 'elements/locations/北境.md'],
    })
  })
})

describe('searchElementEntries', () => {
  it('名称子串（大小写不敏感）+ 可选类型过滤', async () => {
    await writeFile('elements/characters/林澜.md', elementFile({ name: '林澜' }))
    await writeFile('elements/characters/林伯.md', elementFile({ name: '林伯' }))
    await writeFile('elements/locations/林间小屋.md', elementFile({ name: '林间小屋', type: 'location' }))

    const index = await buildElementReferenceIndex(project())
    expect(searchElementEntries(index, '林')).toHaveLength(3)
    expect(searchElementEntries(index, '林', 'character').map((entry) => entry.name)).toEqual(['林伯', '林澜'])
    expect(searchElementEntries(index, '')).toHaveLength(3)
  })
})

describe('generateElementId / ELEMENT_ID_PATTERN', () => {
  it('生成的标识符合 ELM-10 位格式且不重复（样本量内）', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const id = generateElementId()
      expect(id).toMatch(ELEMENT_ID_PATTERN)
      seen.add(id)
    }
    expect(seen.size).toBeGreaterThan(190)
  })
})

describe('ensureElementId', () => {
  it('缺失 id：在 frontmatter 顶部插入 id 行，正文与其余字段原样保留', async () => {
    const original = elementFile({ name: '林澜', summary: '主角', body: '# 林澜\n\n正文一段' })
    await writeFile('elements/characters/林澜.md', original)

    const result = await ensureElementId(project(), 'elements/characters/林澜.md')
    expect(result.assigned).toBe(true)
    expect(result.id).toMatch(ELEMENT_ID_PATTERN)

    const next = await readProjectTextFile(root, 'elements/characters/林澜.md')
    expect(next).toContain(`id: ${result.id}\n`)
    expect(next).toContain('name: 林澜')
    expect(next).toContain('summary: 主角')
    expect(next.endsWith('# 林澜\n\n正文一段')).toBe(true)
  })

  it('已有非空 id：原样返回不写盘（含人工维护的非 ELM 格式）', async () => {
    const original = elementFile({ name: '林澜', id: 'legacy-42' })
    await writeFile('elements/characters/林澜.md', original)

    const result = await ensureElementId(project(), 'elements/characters/林澜.md')
    expect(result).toEqual({ id: 'legacy-42', assigned: false })
    expect(await readProjectTextFile(root, 'elements/characters/林澜.md')).toBe(original)
  })

  it('空值 id 行（`id:` 后为空）：原位补全，字段顺序不变', async () => {
    const original = [
      '---',
      'type: character',
      'name: 林澜',
      'id:',
      '---',
      '',
      '正文',
    ].join('\n')
    await writeFile('elements/characters/林澜.md', original)

    const result = await ensureElementId(project(), 'elements/characters/林澜.md')
    const next = await readProjectTextFile(root, 'elements/characters/林澜.md')

    expect(next).toContain(`type: character\nname: 林澜\nid: ${result.id}\n---`)
    expect(next.startsWith('---\ntype: character')).toBe(true)
  })

  it('CRLF 文件写回保持 CRLF', async () => {
    const original = elementFile({ name: '林澜' }).replace(/\n/g, '\r\n')
    await writeFile('elements/characters/林澜.md', original)

    await ensureElementId(project(), 'elements/characters/林澜.md')
    const next = await readProjectTextFile(root, 'elements/characters/林澜.md')

    expect(next.includes('\r\n')).toBe(true)
    expect(next.includes('\n')).toBe(true)
    expect(next.match(/^id: ELM-[0-9a-z]{10}\r?$/m)).not.toBeNull()
  })

  it('无 frontmatter 的文件补完整块', async () => {
    await writeFile('elements/characters/裸文件.md', '只有正文')

    const result = await ensureElementId(project(), 'elements/characters/裸文件.md')
    const next = await readProjectTextFile(root, 'elements/characters/裸文件.md')

    expect(next).toBe(`---\nid: ${result.id}\n---\n只有正文`)
  })
})
