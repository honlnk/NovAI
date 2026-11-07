import { describe, expect, it } from 'vitest'
import { searchFilesTool } from './search-text'
import { createElementManagerTools } from '../agent/element-manager'
import { createAgentTools } from '../agent/tools'
import type { ProjectSnapshot } from '../../types/project'
import type { ToolRuntime } from './types'

describe('SearchFiles', () => {
  it('字面匹配：中文人名跨章搜索，返回行号与上下文（D7/D8）', async () => {
    const runtime = createRuntime({
      'chapters/第001章-夜访.txt': '门外传来急促的脚步声。\n林婉儿推门而入，神色慌张。\n「不好了，」她压低声音。',
      'chapters/第002章-对峙.txt': '另一段无关内容。\n林婉儿站在原地。\n尾声。',
      'elements/characters/林婉儿.md': '# 林婉儿\n主角。',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿' }),
      runtime,
    )

    expect(output.totalMatches).toBe(3)
    expect(output.truncated).toBe(false)
    expect(output.content).toContain('chapters/第001章-夜访.txt')
    expect(output.content).toContain('chapters/第002章-对峙.txt')
    expect(output.content).toContain('elements/characters/林婉儿.md')
    // 匹配行带行号，上下文行缩进且带 N | 前缀（默认 2 行上下文）
    expect(output.content).toContain('Line 2: 林婉儿推门而入，神色慌张。')
    expect(output.content).toContain('   1 | 门外传来急促的脚步声。')
    expect(output.content).toContain('   3 | 「不好了，」她压低声音。')
  })

  it('正则匹配：regex: true 时按 JS 正则解释', async () => {
    const runtime = createRuntime({
      'chapters/第001章-风.txt': '东风吹过。\n西风吹过。\n无风。',
    })

    const literal = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '风' }),
      runtime,
    )
    expect(literal.totalMatches).toBe(3)

    const regex = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '[东西]风', regex: true }),
      runtime,
    )
    expect(regex.totalMatches).toBe(2)

    // 字面模式下的正则元字符不被解释
    const literalMeta = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '[东西]风' }),
      runtime,
    )
    expect(literalMeta.totalMatches).toBe(0)
  })

  it('include 过滤：*.txt 只搜章节', async () => {
    const runtime = createRuntime({
      'chapters/第001章-夜访.txt': '林婉儿出现。',
      'elements/characters/林婉儿.md': '林婉儿的设定。',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿', include: '*.txt' }),
      runtime,
    )

    expect(output.totalMatches).toBe(1)
    expect(output.content).toContain('chapters/第001章-夜访.txt')
    expect(output.content).not.toContain('characters/林婉儿.md')
  })

  it('path 限定搜索范围：chapters/ 下不搜要素', async () => {
    const runtime = createRuntime({
      'chapters/第001章-夜访.txt': '林婉儿出现。',
      'elements/characters/林婉儿.md': '林婉儿的设定。',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿', path: 'chapters' }),
      runtime,
    )

    expect(output.totalMatches).toBe(1)
    expect(output.content).toContain('chapters/第001章-夜访.txt')
  })

  it('contextLines 0/2/5 三档（0 = 只有匹配行）', async () => {
    const lines = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
    const runtime = createRuntime({
      'chapters/第001章-数数.txt': lines.join('\n'),
    })

    const zero = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '五', contextLines: 0 }),
      runtime,
    )
    expect(zero.content).toBe('chapters/第001章-数数.txt\nLine 5: 五')
    expect(zero.contextLines).toBe(0)

    const two = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '五', contextLines: 2 }),
      runtime,
    )
    expect(two.content).toContain('   3 | 三')
    expect(two.content).toContain('   7 | 七')
    expect(two.content).not.toContain('   2 | 二')

    const five = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '五', contextLines: 5 }),
      runtime,
    )
    expect(five.content).toContain('   1 | 一')
    expect(five.content).toContain('   9 | 九')
  })

  it('上下文窗口钳制在文件首尾行内', async () => {
    const runtime = createRuntime({
      'chapters/第001章-短.txt': '首行林婉儿\n第二行',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿', contextLines: 5 }),
      runtime,
    )

    expect(output.content).toContain('   1 | 首行林婉儿')
    expect(output.content).toContain('   2 | 第二行')
    expect(output.content).not.toContain('0 |')
  })

  it('单行超过 2000 字符截断（复用 ReadFile 的 READ_MAX_LINE_LENGTH）', async () => {
    const runtime = createRuntime({
      'chapters/第001章-长行.txt': `林婉儿${'很'.repeat(3000)}累`,
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿', contextLines: 0 }),
      runtime,
    )

    expect(output.content).toContain('本行过长，已截断至 2000 字符')
    expect(output.content.length).toBeLessThan(2200)
  })

  it('超限：完整结果落 spill，上下文留前 limit 处预览（D10）', async () => {
    const runtime = createRuntime({
      'chapters/第001章-多.txt': Array.from({ length: 10 }, (_, i) => `林婉儿第${i}次出现`).join('\n'),
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿', limit: 3 }),
      runtime,
    )

    expect(output.totalMatches).toBe(10)
    expect(output.shownMatches).toBe(3)
    expect(output.truncated).toBe(true)
    expect(output.spillPath).toMatch(/^\.novel\/spill\/search-files-.+\.txt$/)

    const spillContent = await readProjectText(runtime, output.spillPath!)
    expect(spillContent).toContain('共 10 处匹配')
    expect(spillContent).toContain('第9次出现')

    const formatted = createAgentTools().SearchFiles.formatResult(output)
    expect(formatted).toContain('Found 3 of 10 matches')
    expect(formatted).toContain(`完整结果已存至 ${output.spillPath}`)
    // 预览页只有前 3 处
    expect(formatted).toContain('第0次出现')
    expect(formatted).not.toContain('第9次出现')
  })

  it('没有匹配时返回空结果', async () => {
    const runtime = createRuntime({
      'chapters/第001章-无.txt': '无关内容',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '不存在的人名' }),
      runtime,
    )

    expect(output.totalMatches).toBe(0)
    expect(output.content).toBe('')
    expect(createAgentTools().SearchFiles.formatResult(output)).toContain('没有找到匹配')
  })

  it('formatResult：未超限时 header 为 Found N matches 且无 spill 文案', async () => {
    const runtime = createRuntime({
      'chapters/第001章-单.txt': '林婉儿出现。',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿' }),
      runtime,
    )

    const formatted = createAgentTools().SearchFiles.formatResult(output)
    expect(formatted).toContain('Found 1 match')
    expect(formatted).not.toContain('spill')
  })
})

describe('SearchFiles 参数校验', () => {
  it('query 空串与非字符串拒绝', () => {
    expect(() => searchFilesTool.validateInput({ query: '' })).toThrow('query 不能为空')
    expect(() => searchFilesTool.validateInput({ query: 123 })).toThrow('query 必须是字符串')
  })

  it('regex: true 时非法正则拒绝', () => {
    expect(() => searchFilesTool.validateInput({ query: '[未闭合', regex: true })).toThrow('不是合法的 JS 正则')
  })

  it('include 拒绝空串、! 取反与逗号列表；花括号内逗号允许（D11 对齐 dsh）', () => {
    expect(() => searchFilesTool.validateInput({ query: 'x', include: '  ' })).toThrow('非空 glob')
    expect(() => searchFilesTool.validateInput({ query: 'x', include: '!*.txt' })).toThrow('不支持 ! 取反')
    expect(() => searchFilesTool.validateInput({ query: 'x', include: '*.txt,*.md' })).toThrow('不支持逗号列表')
    expect(() => searchFilesTool.validateInput({ query: 'x', include: '*.{txt,md}' })).not.toThrow()
  })

  it('contextLines 越界与非法值拒绝', () => {
    expect(() => searchFilesTool.validateInput({ query: 'x', contextLines: 6 })).toThrow('0-5')
    expect(() => searchFilesTool.validateInput({ query: 'x', contextLines: -1 })).toThrow('0-5')
    expect(() => searchFilesTool.validateInput({ query: 'x', contextLines: 2.5 })).toThrow('0-5')
  })

  it('limit 非正整数拒绝，超过 500 钳制到 500', () => {
    expect(() => searchFilesTool.validateInput({ query: 'x', limit: 0 })).toThrow('正整数')
    const clamped = searchFilesTool.validateInput({ query: 'x', limit: 9999 })
    expect(clamped.limit).toBe(500)
  })

  it('路径边界：.novel/ 禁读，.novel/spill/ 放行（D11；报错文案为教学式，D5）', () => {
    expect(() => searchFilesTool.validateInput({ query: 'x', path: '.novel' }))
      .toThrow('SearchFiles.path 不能指向应用内部文件')
    expect(() => searchFilesTool.validateInput({ query: 'x', path: '.novel/logs' }))
      .toThrow('SearchFiles.path 不能指向应用内部文件')
    expect(() => searchFilesTool.validateInput({ query: 'x', path: '.novai' }))
      .toThrow('SearchFiles.path 不能指向应用内部文件')
    expect(() => searchFilesTool.validateInput({ query: 'x', path: '.novel/spill' })).not.toThrow()
  })

  it('默认遍历跳过隐藏目录：.novel/ 内的内容不出现在根搜索结果中', async () => {
    const runtime = createRuntime({
      'chapters/第001章-公开.txt': '林婉儿出现。',
      '.novel/logs/session.txt': '林婉儿不该被搜到',
    })

    const output = await searchFilesTool.run(
      searchFilesTool.validateInput({ query: '林婉儿' }),
      runtime,
    )

    expect(output.totalMatches).toBe(1)
    expect(output.content).not.toContain('session.txt')
  })

  it('搜索目录不存在时报错', async () => {
    const runtime = createRuntime({})

    await expect(searchFilesTool.run(
      searchFilesTool.validateInput({ query: 'x', path: '不存在的目录' }),
      runtime,
    )).rejects.toThrow('搜索目录不存在')
  })
})

describe('SearchFiles 装配面', () => {
  it('已注册进 core 工具表与主 Agent 工具面', () => {
    expect(createAgentTools().SearchFiles).toBeDefined()
    expect(createAgentTools().SearchFiles.name).toBe('SearchFiles')
  })

  it('要素管理员工具白名单不含 SearchFiles（D11）', () => {
    const tools = createElementManagerTools()
    expect(tools.SearchFiles).toBeUndefined()
    expect(Object.keys(tools)).not.toContain('SearchFiles')
  })

  it('prompt 工具规则含 SearchFiles 条目与 RagSearch 分工（D9）', async () => {
    const { buildAgentSystemPrompt } = await import('../agent/prompt')
    const prompt = buildAgentSystemPrompt({})

    expect(prompt).toContain('- SearchFiles 用于按文件内容搜索')
    expect(prompt).toContain('- RagSearch：从情节（plots）和时间线（timeline）索引中语义检索')
    expect(prompt).toContain('请用 SearchFiles')
    // 插入位置：FindFiles 之后
    expect(prompt.indexOf('- FindFiles 用于')).toBeLessThan(prompt.indexOf('- SearchFiles 用于'))
  })
})

// ---------- memory 文件系统（项目惯例：各测试文件自带，参照 file-tools.test.ts） ----------

function createRuntime(files: Record<string, string>): ToolRuntime {
  const handle = createMemoryDirectory('novel')

  for (const [path, content] of Object.entries(files)) {
    seedFile(handle, path, content)
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

/** 直接种文件（绕过 createWritable）：SearchFiles 不依赖 mtime，只需内容。 */
function seedFile(rootHandle: MemoryDirectoryHandle, path: string, content: string) {
  let current = rootHandle.__entry

  for (const segment of path.split('/').slice(0, -1)) {
    let next = current.entries.get(segment)

    if (!next || next.kind !== 'directory') {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }

    current = next
  }

  const fileName = path.split('/').pop()!
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
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
