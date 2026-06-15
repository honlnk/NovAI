import { describe, expect, it } from 'vitest'

import { repairProject } from './project-fs'

describe('project fs repair', () => {
  it('does not recreate the default scene prompt after it has been deleted or renamed', async () => {
    const rootHandle = createMemoryDirectory('novel')

    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      project: {
        name: 'Test Novel',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }))
    writeProjectTextSync(rootHandle, '.novel/manifest.json', JSON.stringify({
      projectId: 'test-project',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    }))
    writeProjectTextSync(rootHandle, 'prompts/system.md', '# System Prompt')
    writeProjectTextSync(rootHandle, 'prompts/scenes/renamed-scene.md', '# Renamed Scene Prompt')

    const project = await repairProject(rootHandle)

    expect(project.tree).toContainEqual(expect.objectContaining({
      kind: 'directory',
      path: 'prompts',
    }))
    await expect(readProjectText(rootHandle, 'prompts/scenes/scene-001.md')).rejects.toThrow('Not found')
    await expect(readProjectText(rootHandle, 'prompts/scenes/renamed-scene.md')).resolves.toBe('# Renamed Scene Prompt')
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

function writeProjectTextSync(rootHandle: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle.__entry

  for (const segment of segments) {
    const existing = current.entries.get(segment)

    if (existing?.kind === 'file') {
      throw new Error(`Not a directory: ${segment}`)
    }

    if (existing?.kind === 'directory') {
      current = existing
      continue
    }

    const next: MemoryDirectoryEntry = {
      kind: 'directory',
      name: segment,
      entries: new Map(),
    }
    current.entries.set(segment, next)
    current = next
  }

  current.entries.set(fileName, {
    kind: 'file',
    name: fileName,
    content,
    lastModified: Date.now(),
  })
}

async function readProjectText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const fileHandle = await resolveMemoryFileHandle(rootHandle, path)
  return (await fileHandle.getFile()).text()
}

async function resolveMemoryFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current.getFileHandle(fileName)
}
