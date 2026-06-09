import { describe, expect, it } from 'vitest'
import {
  createFileTool,
  deleteFileTool,
  editFileTool,
  readFileTool,
  renameFileTool,
} from '../file-tools'
import type { ProjectSnapshot } from '../../../types/project'
import type { ToolRuntime } from '../types'

describe('file tools', () => {
  it('requires ReadFile state before EditFile and edits a fresh file', async () => {
    const runtime = createRuntime({
      'chapters/001.txt': '第一段\n第二段',
    })

    await expect(editFileTool.run({
      path: 'chapters/001.txt',
      oldText: '第二段',
      newText: '第二段修改',
    }, runtime)).rejects.toThrow('必须先用 ReadFile')

    const readOutput = await readFileTool.run({ path: 'chapters/001.txt' }, runtime)

    expect(readOutput.numberedContent).toContain('1 | 第一段')

    const editOutput = await editFileTool.run({
      path: 'chapters/001.txt',
      oldText: '第二段',
      newText: '第二段修改',
    }, runtime)

    expect(editOutput.occurrences).toBe(1)
    await expect(readProjectText(runtime.project.handle, 'chapters/001.txt')).resolves.toBe('第一段\n第二段修改')
  })

  it('rejects EditFile when the file changed after ReadFile', async () => {
    const runtime = createRuntime({
      'chapters/001.txt': '旧内容',
    })

    await readFileTool.run({ path: 'chapters/001.txt' }, runtime)
    await writeProjectText(runtime.project.handle, 'chapters/001.txt', '外部修改')

    await expect(editFileTool.run({
      path: 'chapters/001.txt',
      oldText: '旧内容',
      newText: '新内容',
    }, runtime)).rejects.toThrow('已在 ReadFile 之后发生变化')
  })

  it('creates new files but refuses to overwrite existing files', async () => {
    const runtime = createRuntime({
      'chapters/existing.txt': '已有内容',
    })

    await createFileTool.run({
      path: 'chapters/new.txt',
      content: '新内容',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'chapters/new.txt')).resolves.toBe('新内容')
    await expect(createFileTool.run({
      path: 'chapters/existing.txt',
      content: '覆盖内容',
    }, runtime)).rejects.toThrow('文件已存在')
  })

  it('requires new chapter files to use txt extension', async () => {
    const runtime = createRuntime({})

    await expect(createFileTool.run({
      path: 'chapters/new.md',
      content: '新内容',
    }, runtime)).rejects.toThrow('章节正文必须写入 chapters/*.txt')
  })

  it('renames files and refuses to overwrite destination files', async () => {
    const runtime = createRuntime({
      'chapters/source.txt': '源内容',
      'chapters/existing.txt': '已有内容',
    })

    await expect(renameFileTool.run({
      fromPath: 'chapters/source.txt',
      toPath: 'chapters/existing.txt',
    }, runtime)).rejects.toThrow('目标文件已存在')

    await renameFileTool.run({
      fromPath: 'chapters/source.txt',
      toPath: 'chapters/renamed.txt',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'chapters/renamed.txt')).resolves.toBe('源内容')
    await expect(readProjectText(runtime.project.handle, 'chapters/source.txt')).rejects.toThrow('Not found')
  })

  it('allows migrating legacy chapter md files to txt but rejects new md targets', async () => {
    const runtime = createRuntime({
      'chapters/legacy.md': '旧章节',
    })

    await expect(renameFileTool.run({
      fromPath: 'chapters/legacy.md',
      toPath: 'chapters/still-md.md',
    }, runtime)).rejects.toThrow('章节正文必须写入 chapters/*.txt')

    await renameFileTool.run({
      fromPath: 'chapters/legacy.md',
      toPath: 'chapters/legacy.txt',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'chapters/legacy.txt')).resolves.toBe('旧章节')
    await expect(readProjectText(runtime.project.handle, 'chapters/legacy.md')).rejects.toThrow('Not found')
  })

  it('moves deleted files into the project trash', async () => {
    const runtime = createRuntime({
      'chapters/old.txt': '废稿',
    })

    const output = await deleteFileTool.run({ path: 'chapters/old.txt' }, runtime)

    expect(output.trashPath).toMatch(/^\.novel\/trash\/.+\/chapters\/old\.txt$/)
    await expect(readProjectText(runtime.project.handle, output.trashPath)).resolves.toBe('废稿')
    await expect(readProjectText(runtime.project.handle, 'chapters/old.txt')).rejects.toThrow('Not found')
  })
})

function createRuntime(files: Record<string, string>): ToolRuntime {
  const handle = createMemoryDirectory('novel')

  for (const [path, content] of Object.entries(files)) {
    writeProjectTextSync(handle, path, content)
  }

  return {
    project: {
      id: 'test-project',
      name: 'Test Project',
      rootName: 'novel',
      handle,
      config: {} as ProjectSnapshot['config'],
      manifest: {} as ProjectSnapshot['manifest'],
      tree: [],
      metadata: {} as ProjectSnapshot['metadata'],
    },
    readFileStates: new Map(),
  }
}

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

async function writeProjectText(rootHandle: FileSystemDirectoryHandle, path: string, content: string) {
  const fileHandle = await resolveMemoryFileHandle(rootHandle, path, true)
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function readProjectText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const fileHandle = await resolveMemoryFileHandle(rootHandle, path, false)
  return (await fileHandle.getFile()).text()
}

async function resolveMemoryFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create })
  }

  return current.getFileHandle(fileName, { create })
}
