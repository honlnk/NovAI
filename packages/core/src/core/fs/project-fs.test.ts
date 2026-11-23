import { describe, expect, it, vi } from 'vitest'

import { createDefaultConfig, DEFAULT_ELEMENT_SCHEMA } from '../project/defaults'
import {
  createProject,
  inspectProject,
  loadProjectFromHandle,
  readElementSchema,
  readOutlinePrompt,
  readProjectConfig,
  repairProject,
  STRUCTURE_STEP_COUNTS,
  writeProjectConfig,
} from './project-fs'
import type { ProjectLoadProgress, ProjectLoadReporter, TreeNode } from '../../types/project'

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

describe('要素管理员覆盖块归一化（Phase 2 计划 D2/D3）', () => {
  it('无 elementManager 块 → 保持 undefined（全继承，不主动写入默认值）', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))

    const config = await readProjectConfig(rootHandle)
    expect(config.elementManager).toBeUndefined()
  })

  it('完整 llm 覆盖 + 三档 preset 原样保留；reasoningEffort 非法剔除', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      elementManager: {
        llm: {
          baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'claude-x',
          protocol: 'anthropic', reasoningEffort: 'max',
        },
        permissionPreset: 'material',
      },
    }))

    const config = await readProjectConfig(rootHandle)
    expect(config.elementManager?.llm).toEqual({
      baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'claude-x',
      protocol: 'anthropic', reasoningEffort: 'max',
    })
    expect(config.elementManager?.permissionPreset).toBe('material')

    // 非法思考档剔除（无键 → 合成时继承主档）
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      elementManager: {
        llm: {
          baseUrl: 'https://x.com', apiKey: 'k', model: 'm',
          protocol: 'openai', reasoningEffort: 'always' as never,
        },
      },
    }))
    const stripped = await readProjectConfig(rootHandle)
    expect(stripped.elementManager?.llm && 'reasoningEffort' in stripped.elementManager.llm).toBe(false)
  })

  it('llm 覆盖残缺（缺必填/协议非法）→ 整组剔除回退继承；preset 合法则保留', async () => {
    const rootHandle = createMemoryDirectory('novel')

    // 缺 model
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      elementManager: {
        llm: { baseUrl: 'https://x.com', apiKey: 'k', protocol: 'openai' },
        permissionPreset: 'full',
      },
    }))
    let config = await readProjectConfig(rootHandle)
    expect(config.elementManager?.llm).toBeUndefined()
    expect(config.elementManager?.permissionPreset).toBe('full')

    // 协议非法（防半覆盖拼出无效组合）
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      elementManager: {
        llm: { baseUrl: 'https://x.com', apiKey: 'k', model: 'm', protocol: 'grpc' as never },
      },
    }))
    config = await readProjectConfig(rootHandle)
    expect(config.elementManager).toBeUndefined()
  })

  it('permissionPreset 非三档值剔除（chapter/chapter-material 对要素管理员无意义，非法串同理）', async () => {
    const rootHandle = createMemoryDirectory('novel')

    for (const preset of ['chapter', 'chapter-material', 'nonsense']) {
      writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
        elementManager: { permissionPreset: preset as never },
      }))
      const config = await readProjectConfig(rootHandle)
      expect(config.elementManager).toBeUndefined()
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
    const writtenConfig = await readProjectConfig(rootHandle)
    expect(writtenConfig.settings.activeOutlinePath).toBe('prompts/outlines/main.md')
    // 旧字段名随写回丢弃（真机验证发现 ...spread 曾把它原样带回）
    expect((writtenConfig.settings as Record<string, unknown>).activeScenePromptPath).toBeUndefined()
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

/* ---------- 打开类动作的进度上报 ---------- */

describe('project fs load progress', () => {
  it('各段步数是验收口径，不得随意增减', () => {
    expect(STRUCTURE_STEP_COUNTS).toEqual({ inspect: 9, repair: 17, create: 18, load: 3 })
  })

  it('repairProject：结构阶段从 0 报到 20（修复 17 + 读取 3），之后才进入扫描', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)
    writeProjectTextSync(rootHandle, 'chapters/chapter-001.md', '# 第一章')
    writeProjectTextSync(rootHandle, 'elements/characters/主角.md', '# 主角')

    const { events, result } = await collectProgress((onProgress) => repairProject(rootHandle, onProgress))

    const structure = events.filter((event) => event.phase === 'structure')
    // 起点 + 20 步 = 21 次；每一步的总量都是 20
    expect(structure.map((event) => event.current)).toEqual(countUp(0, 20))
    expect(new Set(structure.map((event) => event.total))).toEqual(new Set([20]))
    // 起点不带路径；之后每一步带刚处理完的路径
    expect(structure[0].currentPath).toBeUndefined()
    expect(structure.slice(1).map((event) => event.currentPath)).toEqual([
      'chapters',
      'elements',
      'elements/characters',
      'elements/locations',
      'elements/entities',
      'elements/plots',
      'elements/worldbuilding',
      'prompts',
      'prompts/outlines',
      'plans',
      '.novel',
      '.novel/logs',
      'novel.config.json',
      '.novel/manifest.json',
      'prompts/system.md',
      'prompts/NovAI.md',
      'prompts/ELEMENT.md',
      'prompts/scenes',
      'novel.config.json',
      '.novel/manifest.json',
    ])

    // 结构阶段全部报完才开始扫描，两段不交错
    const scan = events.filter((event) => event.phase === 'scan')
    expect(events).toHaveLength(structure.length + scan.length)
    expect(events[structure.length].phase).toBe('scan')

    // 扫描：每发现一个条目上报一次，计数从第一个条目起逐条加一
    expect(scan[0]).toMatchObject(
      scan[0].files === 1 ? { files: 1, directories: 0 } : { files: 0, directories: 1 },
    )
    expect(scan.every((event, index) => index === 0 || isOneMoreEntry(event, scan[index - 1]))).toBe(true)
    expect(scan.every((event) => typeof event.currentPath === 'string')).toBe(true)
    // 最终计数与文件树的节点数一致
    expect(scan.at(-1)).toMatchObject(countTreeNodes(result.tree))
  })

  it('扫描：发现文件夹时切到该文件夹，发现文件时是它所在的目录', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)
    writeProjectTextSync(rootHandle, 'prompts/outlines/outline-001.md', '# 大纲')

    const { events } = await collectProgress((onProgress) => loadProjectFromHandle(rootHandle, onProgress))

    expect(events.filter((event) => event.phase === 'scan').map((event) => ({
      files: event.files,
      directories: event.directories,
      currentPath: event.currentPath,
    }))).toEqual([
      { files: 1, directories: 0, currentPath: '' },
      { files: 1, directories: 1, currentPath: '.novel' },
      { files: 2, directories: 1, currentPath: '.novel' },
      { files: 2, directories: 2, currentPath: 'prompts' },
      { files: 3, directories: 2, currentPath: 'prompts' },
      { files: 3, directories: 3, currentPath: 'prompts/outlines' },
      { files: 4, directories: 3, currentPath: 'prompts/outlines' },
    ])
  })

  it('loadProjectFromHandle 单独调用：读取 3 步从 0 报到 3', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)

    const { events } = await collectProgress((onProgress) => loadProjectFromHandle(rootHandle, onProgress))

    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual([0, 1, 2, 3])
    expect(structure.every((event) => event.total === 3)).toBe(true)
    expect(structure.slice(1).map((event) => event.currentPath)).toEqual([
      'prompts/scenes',
      'novel.config.json',
      '.novel/manifest.json',
    ])
  })

  it('loadProjectFromHandle 接在修复段之后：接着 17 报到 20，不重复报起点', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)

    const { events } = await collectProgress((onProgress) =>
      loadProjectFromHandle(rootHandle, onProgress, { offset: 17, total: 20 }))

    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual([18, 19, 20])
    expect(structure.every((event) => event.total === 20)).toBe(true)
  })

  it('inspectProject：结构体检 9 步从 0 报到 9', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)

    const { events } = await collectProgress((onProgress) => inspectProject(rootHandle, onProgress))

    // 最小项目缺章节等目录：体检照常走完 9 步，不因发现问题而提前结束
    expect(events.map((event) => event.current)).toEqual(countUp(0, 9))
    expect(events.every((event) => event.phase === 'structure' && event.total === 9)).toBe(true)
    expect(events.slice(1).map((event) => event.currentPath)).toEqual([
      'novel.config.json',
      'novel.config.json',
      '.novel/manifest.json',
      '.novel/manifest.json',
      'prompts/system.md',
      'prompts/outlines',
      'chapters',
      'elements',
      '.novel',
    ])
  })

  it('inspectProject 接在多段动作开头：按传入的总量上报，下一步报 1', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)

    const { events } = await collectProgress((onProgress) =>
      inspectProject(rootHandle, onProgress, { offset: 0, total: 29 }))

    expect(events.map((event) => event.current)).toEqual(countUp(0, 9))
    expect(events.every((event) => event.total === 29)).toBe(true)
  })

  it('inspectProject 接在别的段之后：从 9 接着报到 18，不重复报起点', async () => {
    const rootHandle = createMemoryDirectory('novel')
    seedMinimalProject(rootHandle)

    const { events } = await collectProgress((onProgress) =>
      inspectProject(rootHandle, onProgress, { offset: 9, total: 29 }))

    expect(events.map((event) => event.current)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(events.every((event) => event.total === 29)).toBe(true)
  })

  it('createProject：先报等待授权，结构阶段从 0 报到 21（创建 18 + 读取 3）', async () => {
    const parentHandle = createMemoryDirectory('books')
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => parentHandle) })

    try {
      const { events, result } = await collectProgress((onProgress) => createProject('我的小说', onProgress))

      expect(events[0]).toEqual({ phase: 'permission' })
      const structure = events.filter((event) => event.phase === 'structure')
      expect(structure.map((event) => event.current)).toEqual(countUp(0, 21))
      expect(new Set(structure.map((event) => event.total))).toEqual(new Set([21]))
      expect(structure.slice(13, 19).map((event) => event.currentPath)).toEqual([
        'novel.config.json',
        '.novel/manifest.json',
        'prompts/system.md',
        'prompts/outlines/outline-001.md',
        'prompts/NovAI.md',
        'prompts/ELEMENT.md',
      ])
      expect(events.at(-1)?.phase).toBe('scan')
      expect(events.at(-1)).toMatchObject(countTreeNodes(result.tree))

      expect(result.name).toBe('我的小说')
      expect([...parentHandle.__entry.entries.keys()]).toEqual(['我的小说'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function seedMinimalProject(rootHandle: MemoryDirectoryHandle) {
  writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
    project: { name: 'Test Novel', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }))
  writeProjectTextSync(rootHandle, '.novel/manifest.json', JSON.stringify({
    projectId: 'test-project',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
  }))
  writeProjectTextSync(rootHandle, 'prompts/system.md', '# System Prompt')
}

/** 执行动作并收集全部进度事件。 */
async function collectProgress<T>(run: (onProgress: ProjectLoadReporter) => Promise<T>) {
  const events: ProjectLoadProgress[] = []
  const result = await run((progress) => events.push(progress))
  return { events, result }
}

/** `[from, from + 1, …, to]`。 */
function countUp(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

/** 相比上一条事件，恰好多发现了一个条目（文件或文件夹二选一）。 */
function isOneMoreEntry(event: ProjectLoadProgress, previous: ProjectLoadProgress) {
  const fileDelta = (event.files ?? 0) - (previous.files ?? 0)
  const directoryDelta = (event.directories ?? 0) - (previous.directories ?? 0)
  return (fileDelta === 1 && directoryDelta === 0) || (fileDelta === 0 && directoryDelta === 1)
}

function countTreeNodes(nodes: TreeNode[]): { files: number; directories: number } {
  return nodes.reduce(
    (counts, node) => {
      const own = node.kind === 'directory'
        ? { files: 0, directories: 1 }
        : { files: 1, directories: 0 }
      const nested = node.children ? countTreeNodes(node.children) : { files: 0, directories: 0 }
      return {
        files: counts.files + own.files + nested.files,
        directories: counts.directories + own.directories + nested.directories,
      }
    },
    { files: 0, directories: 0 },
  )
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
