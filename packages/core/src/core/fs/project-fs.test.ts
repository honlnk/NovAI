import { describe, expect, it } from 'vitest'

import { createDefaultConfig, DEFAULT_ELEMENT_SCHEMA } from '../project/defaults'
import { loadProjectFromHandle, readElementSchema, readGardenerPresets, readOutlinePrompt, readProjectConfig, repairProject, writeGardenerPresets, writeProjectConfig } from './project-fs'

describe('project fs repair', () => {
  it('does not recreate the default outline template after it has been deleted or renamed', async () => {
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
    // 旧 scenes/ 目录随打开迁移为 outlines/（内容不动），默认模板不会被重建
    await expect(readProjectText(rootHandle, 'prompts/outlines/outline-001.md')).rejects.toThrow('Not found')
    await expect(readProjectText(rootHandle, 'prompts/outlines/renamed-scene.md')).resolves.toBe('# Renamed Scene Prompt')
  })

  it('要素规范 ELEMENT.md：缺失时补默认内容，已有版本（含用户修改）不覆盖', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      project: { name: 'novel', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }))
    writeProjectTextSync(rootHandle, '.novel/manifest.json', JSON.stringify({
      projectId: 'p1', version: 1, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
    }))
    writeProjectTextSync(rootHandle, 'prompts/system.md', '# System Prompt')

    // 缺失 → 修复补齐默认规范
    await repairProject(rootHandle)
    await expect(readProjectText(rootHandle, 'prompts/ELEMENT.md')).resolves.toBe(DEFAULT_ELEMENT_SCHEMA)
    await expect(readElementSchema(rootHandle)).resolves.toBe(DEFAULT_ELEMENT_SCHEMA)

    // 已有（用户改过）→ 不覆盖
    writeProjectTextSync(rootHandle, 'prompts/ELEMENT.md', '# 我自己定的规范')
    await repairProject(rootHandle)
    await expect(readElementSchema(rootHandle)).resolves.toBe('# 我自己定的规范')
  })

  it('readElementSchema：文件不存在返回空串不抛错', async () => {
    const rootHandle = createMemoryDirectory('novel')
    await expect(readElementSchema(rootHandle)).resolves.toBe('')
  })
})

describe('project config 数值钳制', () => {
  it('越界值钳到 UI 边界，非法值回退默认；agentMaxTurns 钳 0-50', async () => {
    const rootHandle = createMemoryDirectory('novel')
    const config = createDefaultConfig('novel')
    const saved = await writeProjectConfig(rootHandle, {
      ...config,
      rerank: { ...config.rerank, topN: 0 },
      completion: { ...config.completion, debounceMs: 10, maxTokens: 9999 },
      settings: {
        ...config.settings,
        ragCandidateLimit: -3,
        ragContextMaxItems: 500,
        conversationTokenLimit: 5,
        compressionKeepRecentTurns: 0,
        agentMaxTurns: 0,
      },
    })

    expect(saved.settings.conversationTokenLimit).toBe(1000)
    expect(saved.settings.compressionKeepRecentTurns).toBe(1)
    expect(saved.settings.ragCandidateLimit).toBe(1)
    expect(saved.settings.ragContextMaxItems).toBe(50)
    expect(saved.completion.debounceMs).toBe(200)
    expect(saved.completion.maxTokens).toBe(256)
    expect(saved.rerank.topN).toBe(1)
    expect(saved.settings.agentMaxTurns).toBe(0)

    // 上限方向也钳
    const savedHigh = await writeProjectConfig(rootHandle, {
      ...config,
      settings: {
        ...config.settings,
        conversationTokenLimit: 999999,
        compressionKeepRecentTurns: 100,
      },
    })
    expect(savedHigh.settings.conversationTokenLimit).toBe(200000)
    expect(savedHigh.settings.compressionKeepRecentTurns).toBe(20)
  })

  it('agentMaxTurns 迁移：旧版出厂默认 8 → 0（不限），显式值保留，缺省补 0', async () => {
    const rootHandle = createMemoryDirectory('novel')

    // 旧项目持久化的 8（旧版出厂默认）→ 按 0 处理，升级后不再每 8 轮被打断
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: { agentMaxTurns: 8 },
    }))
    expect((await readProjectConfig(rootHandle)).settings.agentMaxTurns).toBe(0)

    // 用户显式选过的其他值尊重保留
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: { agentMaxTurns: 5 },
    }))
    expect((await readProjectConfig(rootHandle)).settings.agentMaxTurns).toBe(5)

    // 缺字段照旧补默认 0；非法值回退 0
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))
    expect((await readProjectConfig(rootHandle)).settings.agentMaxTurns).toBe(0)
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: { agentMaxTurns: 'abc' },
    }))
    expect((await readProjectConfig(rootHandle)).settings.agentMaxTurns).toBe(0)

    // 越界显式值钳到 0-50
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: { agentMaxTurns: 999 },
    }))
    expect((await readProjectConfig(rootHandle)).settings.agentMaxTurns).toBe(50)
  })

  it('JSON 里的非数值（null/字符串/缺失）回退默认值', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: {
        conversationTokenLimit: null,
        compressionKeepRecentTurns: 'abc',
        ragCandidateLimit: 30,
      },
    }))

    const config = await readProjectConfig(rootHandle)

    expect(config.settings.conversationTokenLimit).toBe(12000)
    expect(config.settings.compressionKeepRecentTurns).toBe(5)
    expect(config.settings.ragCandidateLimit).toBe(30)
  })

  it('权限档位：旧配置缺字段回填默认档，非法值回退默认档', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))

    const config = await readProjectConfig(rootHandle)
    expect(config.settings.permissionPreset).toBe('chapter-material')
    await writeProjectConfig(rootHandle, {
      ...config,
      settings: { ...config.settings, permissionPreset: 'nonsense' as never },
    })
    expect((await readProjectConfig(rootHandle)).settings.permissionPreset).toBe('chapter-material')

    // 合法档位原样保留
    await writeProjectConfig(rootHandle, {
      ...config,
      settings: { ...config.settings, permissionPreset: 'review' },
    })
    expect((await readProjectConfig(rootHandle)).settings.permissionPreset).toBe('review')
  })
})

describe('园丁覆盖块归一化（Phase 2 计划 D2/D3）', () => {
  it('无 gardener 块 → 保持 undefined（全继承，不主动写入默认值）', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))

    const config = await readProjectConfig(rootHandle)
    expect(config.gardener).toBeUndefined()
  })

  it('完整 llm 覆盖 + 三档 preset 原样保留；reasoningEffort 非法剔除', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      gardener: {
        llm: {
          baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'claude-x',
          protocol: 'anthropic', reasoningEffort: 'max',
        },
        permissionPreset: 'material',
      },
    }))

    const config = await readProjectConfig(rootHandle)
    expect(config.gardener?.llm).toEqual({
      baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'claude-x',
      protocol: 'anthropic', reasoningEffort: 'max',
    })
    expect(config.gardener?.permissionPreset).toBe('material')

    // 非法思考档剔除（无键 → 合成时继承主档）
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      gardener: {
        llm: {
          baseUrl: 'https://x.com', apiKey: 'k', model: 'm',
          protocol: 'openai', reasoningEffort: 'always' as never,
        },
      },
    }))
    const stripped = await readProjectConfig(rootHandle)
    expect(stripped.gardener?.llm && 'reasoningEffort' in stripped.gardener.llm).toBe(false)
  })

  it('llm 覆盖残缺（缺必填/协议非法）→ 整组剔除回退继承；preset 合法则保留', async () => {
    const rootHandle = createMemoryDirectory('novel')

    // 缺 model
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      gardener: {
        llm: { baseUrl: 'https://x.com', apiKey: 'k', protocol: 'openai' },
        permissionPreset: 'full',
      },
    }))
    let config = await readProjectConfig(rootHandle)
    expect(config.gardener?.llm).toBeUndefined()
    expect(config.gardener?.permissionPreset).toBe('full')

    // 协议非法（防半覆盖拼出无效组合）
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      gardener: {
        llm: { baseUrl: 'https://x.com', apiKey: 'k', model: 'm', protocol: 'grpc' as never },
      },
    }))
    config = await readProjectConfig(rootHandle)
    expect(config.gardener).toBeUndefined()
  })

  it('permissionPreset 非三档值剔除（chapter/chapter-material 对园丁无意义，非法串同理）', async () => {
    const rootHandle = createMemoryDirectory('novel')

    for (const preset of ['chapter', 'chapter-material', 'nonsense']) {
      writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
        gardener: { permissionPreset: preset as never },
      }))
      const config = await readProjectConfig(rootHandle)
      expect(config.gardener).toBeUndefined()
    }
  })
})

describe('scenes→outlines 迁移（W3）', () => {
  function writeLegacyProject(rootHandle: ReturnType<typeof createMemoryDirectory>) {
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      project: { name: 'novel', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      settings: { activeScenePromptPath: 'prompts/scenes/main.md' },
    }))
    writeProjectTextSync(rootHandle, '.novel/manifest.json', JSON.stringify({
      projectId: 'p1', version: 1, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
    }))
    writeProjectTextSync(rootHandle, 'prompts/system.md', '# System Prompt')
    writeProjectTextSync(rootHandle, 'prompts/scenes/main.md', '# 主线大纲')
    writeProjectTextSync(rootHandle, 'prompts/scenes/scene-001.md', '# Scene Prompt\n\n在这里为具体章节记录本场景目标、冲突、登场人物与氛围。')
  }

  it('打开旧项目：scenes/ 文件搬进 outlines/（内容不动）、目录删除、config 路径与旧字段名映射', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeLegacyProject(rootHandle)

    const project = await loadProjectFromHandle(rootHandle)

    // 文件迁移且内容不动
    await expect(readProjectText(rootHandle, 'prompts/outlines/main.md')).resolves.toBe('# 主线大纲')
    await expect(readProjectText(rootHandle, 'prompts/outlines/scene-001.md')).resolves.toContain('# Scene Prompt')
    // scenes/ 目录搬空后删除
    await expect(readProjectText(rootHandle, 'prompts/scenes/main.md')).rejects.toThrow('Not found')
    // config：旧字段名 + scenes/ 前缀 → activeOutlinePath + outlines/ 前缀，且已写回盘
    expect(project.config.settings.activeOutlinePath).toBe('prompts/outlines/main.md')
    expect((await readProjectConfig(rootHandle)).settings.activeOutlinePath).toBe('prompts/outlines/main.md')
    // outlines/ 下的文件可按新路径读到
    await expect(readOutlinePrompt(rootHandle, 'prompts/outlines/main.md')).resolves.toBe('# 主线大纲')
    // 旧路径不再命中（readOutlinePrompt 只认 outlines/ 前缀）
    await expect(readOutlinePrompt(rootHandle, 'prompts/scenes/main.md')).resolves.toBe('')
  })

  it('幂等：再次打开不重复迁移、状态稳定', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeLegacyProject(rootHandle)

    await loadProjectFromHandle(rootHandle)
    const second = await loadProjectFromHandle(rootHandle)

    expect(second.config.settings.activeOutlinePath).toBe('prompts/outlines/main.md')
    await expect(readProjectText(rootHandle, 'prompts/outlines/main.md')).resolves.toBe('# 主线大纲')
    await expect(readProjectText(rootHandle, 'prompts/outlines/scene-001.md')).resolves.toContain('# Scene Prompt')
  })

  it('同名冲突：outlines/ 已有同名文件时 scenes/ 原文件保留、目录不删', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeLegacyProject(rootHandle)
    writeProjectTextSync(rootHandle, 'prompts/outlines/main.md', '# 已存在的大纲')

    await loadProjectFromHandle(rootHandle)

    // 冲突文件不覆盖
    await expect(readProjectText(rootHandle, 'prompts/outlines/main.md')).resolves.toBe('# 已存在的大纲')
    // 无冲突的照常搬走；scenes 里只剩冲突文件、目录保留
    await expect(readProjectText(rootHandle, 'prompts/scenes/main.md')).resolves.toBe('# 主线大纲')
    await expect(readProjectText(rootHandle, 'prompts/scenes/scene-001.md')).rejects.toThrow('Not found')
  })

  it('config 归一化：旧字段/前缀随读随映射，null 与非法值归一', async () => {
    const rootHandle = createMemoryDirectory('novel')

    // 新字段名 + 旧前缀（迁移中途态）也会被归一
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: { activeOutlinePath: 'prompts/scenes/keep.md' },
    }))
    expect((await readProjectConfig(rootHandle)).settings.activeOutlinePath).toBe('prompts/outlines/keep.md')

    // 缺省 / null / 非字符串
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))
    expect((await readProjectConfig(rootHandle)).settings.activeOutlinePath).toBeNull()
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: { activeScenePromptPath: null } }))
    expect((await readProjectConfig(rootHandle)).settings.activeOutlinePath).toBeNull()
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: { activeScenePromptPath: 42 } }))
    expect((await readProjectConfig(rootHandle)).settings.activeOutlinePath).toBeNull()
  })
})

describe('gardener presets（.novai/gardener-presets.json，要素整理参数化 W2）', () => {
  it('文件不存在：返回空数组不抛错（弹窗降级为无快捷选项形态）', async () => {
    const rootHandle = createMemoryDirectory('novel')
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual([])
  })

  it('正常读取 + 写回整表（.novai/ 目录随写自动创建）', async () => {
    const rootHandle = createMemoryDirectory('novel')
    const presets = [
      { label: '只更新变更章节', prompt: '只整理指定章节涉及的要素，不动其他要素文件' },
      { label: '保守合并', prompt: '存疑就不合并' },
    ]

    await writeGardenerPresets(rootHandle, presets)
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual(presets)
    await expect(readProjectText(rootHandle, '.novai/gardener-presets.json')).resolves.toContain('只更新变更章节')

    // 整表替换语义
    await writeGardenerPresets(rootHandle, [{ label: '仅全库核对', prompt: '只核对不写入' }])
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual([
      { label: '仅全库核对', prompt: '只核对不写入' },
    ])
  })

  it('损坏内容容错为空：非法 JSON / presets 非数组 / 项字段非法或为空白', async () => {
    const rootHandle = createMemoryDirectory('novel')

    writeProjectTextSync(rootHandle, '.novai/gardener-presets.json', '{oops')
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual([])

    writeProjectTextSync(rootHandle, '.novai/gardener-presets.json', JSON.stringify({ presets: 'nope' }))
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual([])

    writeProjectTextSync(rootHandle, '.novai/gardener-presets.json', JSON.stringify({
      presets: [
        { label: '合法', prompt: '正常选项' },
        { label: '', prompt: '空 label 被丢' },
        { label: '空 prompt 被丢', prompt: '   ' },
        { label: 42, prompt: '字段类型非法被丢' },
        null,
      ],
    }))
    await expect(readGardenerPresets(rootHandle)).resolves.toEqual([{ label: '合法', prompt: '正常选项' }])
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
