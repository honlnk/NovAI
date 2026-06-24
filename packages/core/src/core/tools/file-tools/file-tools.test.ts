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
      'chapters/第001章-初遇.txt': '第一段\n第二段',
    })

    await expect(editFileTool.run({
      path: 'chapters/第001章-初遇.txt',
      oldText: '第二段',
      newText: '第二段修改',
    }, runtime)).rejects.toThrow('必须先用 ReadFile')

    const readOutput = await readFileTool.run({ path: 'chapters/第001章-初遇.txt' }, runtime)

    expect(readOutput.numberedContent).toContain('1 | 第一段')

    const editOutput = await editFileTool.run({
      path: 'chapters/第001章-初遇.txt',
      oldText: '第二段',
      newText: '第二段修改',
    }, runtime)

    expect(editOutput.occurrences).toBe(1)
    await expect(readProjectText(runtime.project.handle, 'chapters/第001章-初遇.txt')).resolves.toBe('第一段\n第二段修改')
  })

  it('rejects EditFile when the file changed after ReadFile', async () => {
    const runtime = createRuntime({
      'chapters/第001章-初遇.txt': '旧内容',
    })

    await readFileTool.run({ path: 'chapters/第001章-初遇.txt' }, runtime)
    await writeProjectText(runtime.project.handle, 'chapters/第001章-初遇.txt', '外部修改')

    await expect(editFileTool.run({
      path: 'chapters/第001章-初遇.txt',
      oldText: '旧内容',
      newText: '新内容',
    }, runtime)).rejects.toThrow('已在 ReadFile 之后发生变化')
  })

  it('creates new files but refuses to overwrite existing files', async () => {
    const runtime = createRuntime({
      'elements/characters/已有.md': '已有内容',
    })

    await createFileTool.run({
      path: 'elements/characters/新建.md',
      content: '新内容',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'elements/characters/新建.md')).resolves.toBe('新内容')
    await expect(createFileTool.run({
      path: 'elements/characters/已有.md',
      content: '覆盖内容',
    }, runtime)).rejects.toThrow('文件已存在')
  })

  it('rejects creating a chapter with a duplicated number', async () => {
    const runtime = createRuntime({
      'chapters/第001章-已有.txt': '已有内容',
    })

    // 同编号不同标题，应被重号检测拦下（先于"文件已存在"检查）
    await expect(createFileTool.run({
      path: 'chapters/第001章-撞号.txt',
      content: '新内容',
    }, runtime)).rejects.toThrow('章节编号已存在：第001章')
  })

  it('requires new chapter files to use txt extension', async () => {
    const runtime = createRuntime({})

    await expect(createFileTool.run({
      path: 'chapters/第001章-新建.md',
      content: '新内容',
    }, runtime)).rejects.toThrow('章节正文必须写入 chapters/*.txt')
  })

  it('renames files and refuses to overwrite destination files', async () => {
    const runtime = createRuntime({
      'elements/characters/源.md': '源内容',
      'elements/characters/已有.md': '已有内容',
    })

    await expect(renameFileTool.run({
      fromPath: 'elements/characters/源.md',
      toPath: 'elements/characters/已有.md',
    }, runtime)).rejects.toThrow('目标文件已存在')

    await renameFileTool.run({
      fromPath: 'elements/characters/源.md',
      toPath: 'elements/characters/改名.md',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'elements/characters/改名.md')).resolves.toBe('源内容')
    await expect(readProjectText(runtime.project.handle, 'elements/characters/源.md')).rejects.toThrow('Not found')
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
      toPath: 'chapters/第001章-旧章节.txt',
    }, runtime)

    await expect(readProjectText(runtime.project.handle, 'chapters/第001章-旧章节.txt')).resolves.toBe('旧章节')
    await expect(readProjectText(runtime.project.handle, 'chapters/legacy.md')).rejects.toThrow('Not found')
  })

  it('moves deleted files into the project trash', async () => {
    const runtime = createRuntime({
      'chapters/第001章-废稿.txt': '废稿',
    })

    const output = await deleteFileTool.run({ path: 'chapters/第001章-废稿.txt' }, runtime)

    expect(output.trashPath).toMatch(/^\.novel\/trash\/.+\/chapters\/第001章-废稿\.txt$/)
    await expect(readProjectText(runtime.project.handle, output.trashPath)).resolves.toBe('废稿')
    await expect(readProjectText(runtime.project.handle, 'chapters/第001章-废稿.txt')).rejects.toThrow('Not found')
  })

  describe('extractFileChange', () => {
    // 写工具成功执行后必须声明结构化文件变更，供 service 层推导 changedFiles，
    // 不再依赖工具结果文本反推。
    it('CreateFile declares a created change', async () => {
      const runtime = createRuntime({})
      const output = await createFileTool.run({ path: 'chapters/第001章-新建.txt', content: '内容' }, runtime)

      expect(createFileTool.extractFileChange?.(output)).toEqual({ type: 'created', path: 'chapters/第001章-新建.txt' })
    })

    it('EditFile declares an updated change', async () => {
      const runtime = createRuntime({ 'chapters/第001章-初遇.txt': '第一段\n第二段' })
      await readFileTool.run({ path: 'chapters/第001章-初遇.txt' }, runtime)
      const output = await editFileTool.run({
        path: 'chapters/第001章-初遇.txt',
        oldText: '第二段',
        newText: '第二段修改',
      }, runtime)

      expect(editFileTool.extractFileChange?.(output)).toEqual({ type: 'updated', path: 'chapters/第001章-初遇.txt' })
    })

    it('RenameFile declares a renamed change', async () => {
      const runtime = createRuntime({ 'chapters/第001章-源.txt': '源内容' })
      const output = await renameFileTool.run({
        fromPath: 'chapters/第001章-源.txt',
        toPath: 'chapters/第002章-改名.txt',
      }, runtime)

      expect(renameFileTool.extractFileChange?.(output)).toEqual({
        type: 'renamed',
        fromPath: 'chapters/第001章-源.txt',
        toPath: 'chapters/第002章-改名.txt',
      })
    })

    it('DeleteFile declares a deleted change with trashPath', async () => {
      const runtime = createRuntime({ 'chapters/第001章-废稿.txt': '废稿' })
      const output = await deleteFileTool.run({ path: 'chapters/第001章-废稿.txt' }, runtime)

      expect(deleteFileTool.extractFileChange?.(output)).toEqual({
        type: 'deleted',
        path: 'chapters/第001章-废稿.txt',
        trashPath: output.trashPath,
      })
    })

    it('read-only tools do not declare file changes', () => {
      expect(readFileTool.extractFileChange).toBeUndefined()
    })
  })

  describe('chapter naming convention', () => {
    it('CreateFile rejects chapter names that do not match the convention', async () => {
      const runtime = createRuntime({})

      // 无标题
      await expect(createFileTool.run({
        path: 'chapters/第001章.txt',
        content: '内容',
      }, runtime)).rejects.toThrow('章节文件名不规范')
      // 补零不足
      await expect(createFileTool.run({
        path: 'chapters/第1章-火中拾婴.txt',
        content: '内容',
      }, runtime)).rejects.toThrow('章节文件名不规范')
      // 错扩展名（先撞扩展名约束）
      await expect(createFileTool.run({
        path: 'chapters/第001章-火中拾婴.md',
        content: '内容',
      }, runtime)).rejects.toThrow('章节正文必须写入 chapters/*.txt')
    })

    it('CreateFile allows a fresh chapter number and blocks a duplicated one', async () => {
      const runtime = createRuntime({
        'chapters/第001章-火中拾婴.txt': '已有',
      })

      // 不同编号正常创建
      await createFileTool.run({
        path: 'chapters/第002章-留他一命.txt',
        content: '新章节',
      }, runtime)
      await expect(readProjectText(runtime.project.handle, 'chapters/第002章-留他一命.txt')).resolves.toBe('新章节')

      // 同编号不同标题，被重号检测拦下
      await expect(createFileTool.run({
        path: 'chapters/第001章-另一个标题.txt',
        content: '撞号',
      }, runtime)).rejects.toThrow('章节编号已存在：第001章')
    })

    it('EditFile refuses to edit a non-compliant chapter name', () => {
      // validateInput 层就拦下不规范章节名（对称强制），旧的不规范章节必须先整理改名
      expect(() => editFileTool.validateInput({
        path: 'chapters/legacy.txt',
        oldText: '旧内容',
        newText: '新内容',
      })).toThrow('章节文件名不规范')

      // 规范章节名通过格式校验
      expect(() => editFileTool.validateInput({
        path: 'chapters/第001章-初遇.txt',
        oldText: '旧内容',
        newText: '新内容',
      })).not.toThrow()
    })

    it('RenameFile blocks a duplicated chapter number on the target path', async () => {
      const runtime = createRuntime({
        'chapters/第001章-源.txt': '源内容',
        'chapters/第002章-已有.txt': '已有内容',
      })

      // 改名到已占用编号被拦
      await expect(renameFileTool.run({
        fromPath: 'chapters/第001章-源.txt',
        toPath: 'chapters/第002章-撞号.txt',
      }, runtime)).rejects.toThrow('章节编号已存在：第002章')

      // 改名到自身同编号不同标题（仅改标题）应该放行，exceptPath 排除自身
      await renameFileTool.run({
        fromPath: 'chapters/第001章-源.txt',
        toPath: 'chapters/第001章-改标题.txt',
      }, runtime)
      await expect(readProjectText(runtime.project.handle, 'chapters/第001章-改标题.txt')).resolves.toBe('源内容')
    })

    it('legacy non-compliant chapters do not pollute the used number set', async () => {
      // legacy.txt 解析不出编号，不应占用任何编号
      const runtime = createRuntime({
        'chapters/legacy.txt': '旧',
      })

      // 第001章 不应被认为与 legacy.txt 撞号
      await createFileTool.run({
        path: 'chapters/第001章-新.txt',
        content: '新',
      }, runtime)
      await expect(readProjectText(runtime.project.handle, 'chapters/第001章-新.txt')).resolves.toBe('新')
    })
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
