import { describe, expect, it } from 'vitest'
import { findFilesTool, listDirectoryTool, sampleAcrossTopLevel } from './directory-tools'
import { createAgentTools } from '../agent/tools'
import type { ProjectSnapshot } from '../../types/project'
import type { ToolRuntime } from './types'

describe('FindFiles', () => {
  it('结果按修改时间降序，同 mtime 按路径字典序兜底（D3）', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001章-旧.txt', 'a', 1000)
    seedFile(runtime, 'chapters/第002章-新.txt', 'b', 3000)
    seedFile(runtime, 'elements/characters/中.md', 'c', 2000)
    seedFile(runtime, 'prompts/同刻.md', 'd', 3000)

    const output = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*' }),
      runtime,
    )

    expect(output.filenames).toEqual([
      'chapters/第002章-新.txt',
      'prompts/同刻.md',
      'elements/characters/中.md',
      'chapters/第001章-旧.txt',
    ])
    expect(output.truncated).toBe(false)
  })

  it('无 / 的模式匹配任意深度的 basename（D6）', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001章-初遇.txt', 'a', 1000)
    seedFile(runtime, 'elements/characters/林婉儿.md', 'b', 2000)
    seedFile(runtime, 'notes/深层/嵌套/散记.txt', 'c', 3000)
    seedFile(runtime, '根.txt', 'd', 4000)

    const txtOutput = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '*.txt' }),
      runtime,
    )

    expect(new Set(txtOutput.filenames)).toEqual(new Set([
      'chapters/第001章-初遇.txt',
      'notes/深层/嵌套/散记.txt',
      '根.txt',
    ]))

    const mdOutput = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '*.md' }),
      runtime,
    )

    expect(mdOutput.filenames).toEqual(['elements/characters/林婉儿.md'])
  })

  it('含 / 的模式仍锚定路径深度（回归）', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001章-直下.txt', 'a', 1000)
    seedFile(runtime, 'chapters/子目录/深层.txt', 'b', 2000)

    const shallow = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: 'chapters/*.txt' }),
      runtime,
    )
    expect(shallow.filenames).toEqual(['chapters/第001章-直下.txt'])

    const deep = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: 'chapters/**/*.txt' }),
      runtime,
    )
    expect(new Set(deep.filenames)).toEqual(new Set([
      'chapters/第001章-直下.txt',
      'chapters/子目录/深层.txt',
    ]))
  })

  it('超限时跨顶层目录轮转采样，每个子目录都有代表（D4）', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001.txt', 'a', 5000)
    seedFile(runtime, 'chapters/第002.txt', 'b', 4000)
    seedFile(runtime, 'chapters/第003.txt', 'c', 3000)
    seedFile(runtime, 'elements/甲.md', 'd', 2500)
    seedFile(runtime, 'elements/乙.md', 'e', 2000)
    seedFile(runtime, 'prompts/大纲.md', 'f', 1500)

    const output = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*', limit: 4 }),
      runtime,
    )

    expect(output.truncated).toBe(true)
    expect(output.totalMatches).toBe(6)
    expect(output.numFiles).toBe(4)
    expect(output.sampledTopLevelDirs).toBe(3)
    expect(output.totalTopLevelDirs).toBe(3)

    // 三个顶层目录各有代表（chapters 两个、elements 一个、prompts 一个）
    const topLevel = output.filenames.map((path) => path.slice(0, path.indexOf('/')))
    expect(new Set(topLevel)).toEqual(new Set(['chapters', 'elements', 'prompts']))
  })

  it('超限完整结果落 spill 并附取回指引（D5）', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001.txt', 'a', 5000)
    seedFile(runtime, 'chapters/第002.txt', 'b', 4000)
    seedFile(runtime, 'elements/甲.md', 'c', 3000)
    seedFile(runtime, 'prompts/大纲.md', 'd', 2000)

    const output = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*', limit: 2 }),
      runtime,
    )

    expect(output.spillPath).toMatch(/^\.novel\/spill\/find-files-.+\.txt$/)

    const spillContent = await readProjectText(runtime, output.spillPath!)
    expect(spillContent).toContain('共 4 个匹配')
    for (const path of ['chapters/第001.txt', 'chapters/第002.txt', 'elements/甲.md', 'prompts/大纲.md']) {
      expect(spillContent).toContain(path)
    }

    const formatted = createAgentTools().FindFiles.formatResult(output)
    expect(formatted).toContain('采样展示 2 个')
    expect(formatted).toContain(`完整列表已存至 ${output.spillPath}`)
    expect(formatted).toContain('可用 ReadFile')
  })

  it('未超限时完整返回且不产生 spill 文案', async () => {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001.txt', 'a', 1000)
    seedFile(runtime, 'elements/甲.md', 'b', 2000)

    const output = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*' }),
      runtime,
    )

    expect(output.truncated).toBe(false)
    expect(output.spillPath).toBeUndefined()
    expect(output.filenames).toEqual(['elements/甲.md', 'chapters/第001.txt'])

    const formatted = createAgentTools().FindFiles.formatResult(output)
    expect(formatted).not.toContain('采样')
    expect(formatted).not.toContain('spill')
  })
})

describe('内部文件不可见化（D2/D3：无开关，任何参数组合都不出现）', () => {
  function seedInternalProject(): ToolRuntime {
    const runtime = createRuntime()
    seedFile(runtime, 'chapters/第001章-公开.txt', '正文', 1000)
    seedFile(runtime, 'elements/甲.md', '设定', 2000)
    seedFile(runtime, 'novel.config.json', '{"apiKey": "sk-FAKE-KEY"}', 3000)
    seedFile(runtime, '.novel/trash/20260101/chapters/废稿.txt', '废稿', 4000)
    seedFile(runtime, '.novel/spill/find-files-x1.txt', '溢出列表', 5000)
    seedFile(runtime, '.novai/session-state.json', '{}', 6000)
    seedFile(runtime, '.DS_Store', 'binary', 7000)
    return runtime
  }

  it('ListDirectory 根目录不列 novel.config.json、.novel、.novai（含 .DS_Store 等点开头条目）', async () => {
    const runtime = seedInternalProject()

    const output = await listDirectoryTool.run(
      listDirectoryTool.validateInput({}),
      runtime,
    )

    const names = output.entries.map((entry) => entry.name)
    expect(names).toEqual(['chapters', 'elements'])
    expect(names).not.toContain('novel.config.json')
    expect(names).not.toContain('.novel')
    expect(names).not.toContain('.novai')
    // 遗留字段恒 false（计划 §七：保留字段避免类型级联）
    expect(output.entries.every((entry) => entry.hidden === false)).toBe(true)
  })

  it('ListDirectory 大小写变体路径同样拒绝，spill 目录显式列出放行', () => {
    expect(() => listDirectoryTool.validateInput({ path: '.novel' }))
      .toThrow('ListDirectory.path 不能指向应用内部文件')
    expect(() => listDirectoryTool.validateInput({ path: '.NOVEL/trash' }))
      .toThrow('ListDirectory.path 不能指向应用内部文件')
    expect(() => listDirectoryTool.validateInput({ path: '.novai' }))
      .toThrow('ListDirectory.path 不能指向应用内部文件')
    expect(() => listDirectoryTool.validateInput({ path: '.novel/spill' })).not.toThrow()
  })

  it('FindFiles 任意模式都不匹配 novel.config.json 与内部目录内容（walkFiles 层跳过）', async () => {
    const runtime = seedInternalProject()

    const jsonOutput = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '*.json' }),
      runtime,
    )
    expect(jsonOutput.filenames).toEqual([])

    const allOutput = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*' }),
      runtime,
    )
    expect(new Set(allOutput.filenames)).toEqual(new Set([
      'chapters/第001章-公开.txt',
      'elements/甲.md',
    ]))
  })

  it('FindFiles 显式指向内部目录报教学文案，显式查找 spill 照常（豁免三角）', async () => {
    const runtime = seedInternalProject()

    expect(() => findFilesTool.validateInput({ pattern: '**/*', path: '.novel' }))
      .toThrow('FindFiles.path 不能指向应用内部文件')
    expect(() => findFilesTool.validateInput({ pattern: '**/*', path: '.novai' }))
      .toThrow('FindFiles.path 不能指向应用内部文件')

    const spillOutput = await findFilesTool.run(
      findFilesTool.validateInput({ pattern: '**/*', path: '.novel/spill' }),
      runtime,
    )
    expect(spillOutput.filenames).toEqual(['.novel/spill/find-files-x1.txt'])
  })
})

describe('sampleAcrossTopLevel（采样算法单元）', () => {
  it('轮转取样保证每个顶层目录先拿一轮，组内保持传入顺序（dsh 同款组聚平铺）', () => {
    const paths = [
      'chapters/1.txt',
      'chapters/2.txt',
      'chapters/3.txt',
      'elements/a.md',
      'elements/b.md',
      'prompts/o.md',
    ]

    const sample = sampleAcrossTopLevel(paths, 4, '')

    // 三个组各先拿一轮（名额 3），第 4 个名额轮回到 chapters；flat 后按组聚顺序平铺（对齐 dsh）
    expect(sample.items).toEqual(['chapters/1.txt', 'chapters/2.txt', 'elements/a.md', 'prompts/o.md'])
    expect(sample.shown).toBe(3)
    expect(sample.total).toBe(3)
  })

  it('搜索根前缀被剥掉后再分组（path=chapters 时组是 chapters 直下子目录）', () => {
    const paths = [
      'chapters/卷一/1.txt',
      'chapters/卷一/2.txt',
      'chapters/卷二/3.txt',
    ]

    const sample = sampleAcrossTopLevel(paths, 2, 'chapters')

    expect(sample.total).toBe(2)
    expect(sample.items).toEqual(['chapters/卷一/1.txt', 'chapters/卷二/3.txt'])
  })

  it('扁平结果（无子目录）退化为 mtime 序头部', () => {
    const paths = ['a.txt', 'b.txt', 'c.txt']

    expect(sampleAcrossTopLevel(paths, 2, '').items).toEqual(['a.txt', 'b.txt'])
  })
})

// ---------- memory 文件系统（项目惯例：各测试文件自带，参照 file-tools.test.ts） ----------

function createRuntime(): ToolRuntime {
  const handle = createMemoryDirectory('novel')

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

/** 直接种文件（绕过 createWritable），以便测试精确控制 lastModified。 */
function seedFile(runtime: ToolRuntime, path: string, content: string, lastModified: number) {
  let current = (runtime.project.handle as MemoryDirectoryHandle).__entry

  for (const segment of path.split('/').slice(0, -1)) {
    let next = current.entries.get(segment)

    if (!next || next.kind !== 'directory') {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }

    current = next
  }

  const fileName = path.split('/').pop()!
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified })
}

async function readProjectText(runtime: ToolRuntime, path: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()
  let current: FileSystemDirectoryHandle = runtime.project.handle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return (await current.getFileHandle(fileName!)).getFile().then((file) => file.text())
}
