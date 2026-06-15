import { describe, expect, it } from 'vitest'

import { createElementDocument, writeElementDocuments } from './writer'

describe('elements', () => {
  it('writes element documents and skips unchanged writes', async () => {
    const handle = createMemoryDirectory('novel')
    const element = createElementDocument({
      type: 'character',
      name: '林远',
      summary: '年轻修士，正在调查藏书楼旧信。',
      tags: ['人物', '主角'],
      lastUpdatedChapter: 'chapters/第001章.txt',
      relatedChapters: ['chapters/第001章.txt'],
      body: '## 人物线索\n\n- 林远发现旧信。',
    })

    const first = await writeElementDocuments(handle, [element])

    expect(first.created).toEqual(['elements/characters/林远.md'])
    expect(first.updated).toEqual([])
    expect(first.skipped).toEqual([])
    expect(first.staleIndex).toBe(true)

    const content = await readProjectText(handle, 'elements/characters/林远.md')
    expect(content).toContain('id: character-林远')
    expect(content).toContain('summary: 年轻修士')

    const second = await writeElementDocuments(handle, [element])

    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.skipped).toEqual(['elements/characters/林远.md'])
    expect(second.staleIndex).toBe(false)
  })

  it('writes entity documents into elements/entities', async () => {
    const handle = createMemoryDirectory('novel')
    const element = createElementDocument({
      type: 'entity',
      name: '青霜剑',
      summary: '林远当前持有的佩剑。',
      tags: ['实体', '武器'],
      lastUpdatedChapter: 'chapters/第001章.txt',
      relatedChapters: ['chapters/第001章.txt'],
      body: '## 实体线索\n\n- 林远取出青霜剑。',
    })

    const result = await writeElementDocuments(handle, [element])

    expect(result.created).toEqual(['elements/entities/青霜剑.md'])
    await expect(readProjectText(handle, 'elements/entities/青霜剑.md')).resolves.toContain('type: entity')
  })
})

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

async function readProjectText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  const fileHandle = await current.getFileHandle(fileName)
  return (await fileHandle.getFile()).text()
}
