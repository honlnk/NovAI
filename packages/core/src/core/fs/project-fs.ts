import { createDefaultConfig, createDefaultManifest, DEFAULT_CONFIG, DEFAULT_ELEMENT_SCHEMA, DEFAULT_OUTLINE_TEMPLATE, DEFAULT_SYSTEM_PROMPT, isGardenerPermissionPreset, isModelProtocol, isPermissionPreset, isReasoningEffort, isSearchProvider } from '../project/defaults'

import type {
  ProjectInspection,
  ProjectConfig,
  ProjectFileContent,
  ProjectManifest,
  ProjectSnapshot,
  RecentProject,
  TreeNode,
} from '../../types/project'

const TEXT_FILE_EXTENSIONS = ['.md', '.json', '.txt']
const ROOT_DIRECTORY_ORDER = ['chapters', 'elements', 'prompts', '.novel']
const REQUIRED_DIRECTORY_PATHS = [
  'chapters',
  'elements',
  'elements/characters',
  'elements/locations',
  'elements/entities',
  'elements/timeline',
  'elements/plots',
  'elements/worldbuilding',
  'prompts',
  'prompts/outlines',
  '.novel',
  '.novel/logs',
] as const

const OUTLINES_DIRECTORY = 'prompts/outlines'
const LEGACY_SCENES_DIRECTORY = 'prompts/scenes'

/**
 * 判断当前运行环境是否支持浏览器目录读写能力。
 * 测试页在执行任何项目级操作前都应先用它做兜底判断。
 */
export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * 创建一个新的小说项目目录，并写入最小可用的默认结构与配置文件。
 * 返回值会携带完整快照，调用方可以直接把它当作“当前项目”使用。
 */
export async function createProject(projectName: string): Promise<ProjectSnapshot> {
  const parentHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
  const rootHandle = await parentHandle.getDirectoryHandle(projectName, { create: true })
  const projectId = createProjectId()

  for (const directoryPath of REQUIRED_DIRECTORY_PATHS) {
    await ensureDirectory(rootHandle, directoryPath)
  }

  await writeJson(rootHandle, 'novel.config.json', createDefaultConfig(projectName))
  await writeJson(rootHandle, '.novel/manifest.json', createDefaultManifest(projectId))
  await writeText(rootHandle, 'prompts/system.md', DEFAULT_SYSTEM_PROMPT)
  await writeText(rootHandle, 'prompts/outlines/outline-001.md', DEFAULT_OUTLINE_TEMPLATE)
  // 项目记忆无默认模板（W2 起非空即注入为 user-role reminder）：新项目留空占位，
  // 内容交给 /生成项目记忆 或用户手写，避免「待补充」骨架每轮灌进上下文。
  await writeText(rootHandle, 'prompts/NovAI.md', '')
  await writeText(rootHandle, 'prompts/ELEMENT.md', DEFAULT_ELEMENT_SCHEMA)

  return loadProjectFromHandle(rootHandle)
}

/**
 * 让用户选择一个已有项目目录，并按当前项目结构直接加载。
 * 这个方法假设目录已经是合法项目；若需要更温和的打开流程，请先用 `pickProjectDirectory` + `inspectProject`。
 */
export async function openProject(): Promise<ProjectSnapshot> {
  const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
  return loadProjectFromHandle(rootHandle)
}

/**
 * 仅让用户选择目录句柄，不附带任何项目合法性判断。
 * 适合“打开项目前先检查/修复”的交互流程。
 */
export async function pickProjectDirectory() {
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

/**
 * 检查一个目录是否满足 NovAI 最小项目结构。
 * 返回的 issues 会区分“文件缺失”和“文件存在但已损坏”两种情况，便于测试页决定是否提供修复入口。
 */
export async function inspectProject(rootHandle: FileSystemDirectoryHandle): Promise<ProjectInspection> {
  const issues: ProjectInspection['issues'] = []

  // 配置和清单除了要存在，也要能成功解析，否则后续加载仍会失败。
  const hasConfig = await pathExists(rootHandle, 'novel.config.json', 'file')
  const hasManifest = await pathExists(rootHandle, '.novel/manifest.json', 'file')

  if (!hasConfig) {
    issues.push('missing-config')
  } else if (!(await isJsonFileValid<ProjectConfig>(rootHandle, 'novel.config.json'))) {
    issues.push('invalid-config')
  }

  if (!hasManifest) {
    issues.push('missing-manifest')
  } else if (!(await isJsonFileValid<ProjectManifest>(rootHandle, '.novel/manifest.json'))) {
    issues.push('invalid-manifest')
  }

  if (!(await pathExists(rootHandle, 'prompts/system.md', 'file'))) {
    issues.push('missing-prompts-system')
  }

  // 兼容旧目录：未迁移的旧项目仍是 prompts/scenes/（loadProjectFromHandle 会自动迁移），
  // 不能因此判损坏——两目录任一存在即通过。
  if (
    !(await pathExists(rootHandle, OUTLINES_DIRECTORY, 'directory'))
    && !(await pathExists(rootHandle, LEGACY_SCENES_DIRECTORY, 'directory'))
  ) {
    issues.push('missing-prompts-outlines')
  }

  if (!(await pathExists(rootHandle, 'chapters', 'directory'))) {
    issues.push('missing-chapters')
  }

  if (!(await hasRequiredElementDirectories(rootHandle))) {
    issues.push('missing-elements')
  }

  if (!(await pathExists(rootHandle, '.novel', 'directory'))) {
    issues.push('missing-internal-directory')
  }

  return {
    rootName: rootHandle.name,
    issues,
    canLoad: issues.length === 0,
  }
}

/**
 * 尝试把任意目录补齐为可加载的 NovAI 项目。
 * 它会创建缺失目录、补齐默认文件，并在配置/清单损坏时重建为可用内容。
 */
export async function repairProject(
  rootHandle: FileSystemDirectoryHandle,
): Promise<ProjectSnapshot> {
  for (const directoryPath of REQUIRED_DIRECTORY_PATHS) {
    await ensureDirectory(rootHandle, directoryPath)
  }

  const hasConfig = await pathExists(rootHandle, 'novel.config.json', 'file')
  const hasManifest = await pathExists(rootHandle, '.novel/manifest.json', 'file')
  // 修复时优先保留已有项目名；只有缺失或为空时才回退到目录名。
  const repairedProjectName = await resolveProjectNameForRepair(rootHandle)

  if (!hasConfig || !(await isJsonFileValid<ProjectConfig>(rootHandle, 'novel.config.json'))) {
    await writeJson(rootHandle, 'novel.config.json', createDefaultConfig(repairedProjectName))
  } else {
    const currentConfig = await readJson<ProjectConfig>(rootHandle, 'novel.config.json')

    if (!currentConfig.project.name.trim()) {
      await writeJson(rootHandle, 'novel.config.json', {
        ...currentConfig,
        project: {
          ...currentConfig.project,
          name: repairedProjectName,
          updatedAt: new Date().toISOString(),
        },
      })
    }
  }

  if (!hasManifest || !(await isJsonFileValid<ProjectManifest>(rootHandle, '.novel/manifest.json'))) {
    await writeJson(rootHandle, '.novel/manifest.json', createDefaultManifest(createProjectId()))
  }

  if (!(await pathExists(rootHandle, 'prompts/system.md', 'file'))) {
    await writeText(rootHandle, 'prompts/system.md', DEFAULT_SYSTEM_PROMPT)
  }

  // 项目总览 NovAI.md 缺失时补空占位（同新项目：无默认模板，非空即注入）。
  // 它是可选文件（缺失时读取返回空串，Agent 仍能正常工作），因此不纳入 inspectProject
  // 的强制检测项，只在这里温和补齐，避免给所有旧项目报“缺失”。
  if (!(await pathExists(rootHandle, 'prompts/NovAI.md', 'file'))) {
    await writeText(rootHandle, 'prompts/NovAI.md', '')
  }

  // 要素库规范 ELEMENT.md 缺失时补默认内容（园丁子代理的唯一注入文件，随要素园丁 Phase 1 引入）。
  // 与 NovAI.md 同策略：温和补齐、不覆盖用户已修改的版本、不纳入强制检测项。
  if (!(await pathExists(rootHandle, 'prompts/ELEMENT.md', 'file'))) {
    await writeText(rootHandle, 'prompts/ELEMENT.md', DEFAULT_ELEMENT_SCHEMA)
  }

  return loadProjectFromHandle(rootHandle)
}

/**
 * 从一个已知合法的目录句柄中读取配置、清单和文件树，并组装成项目快照。
 * 这是测试页后续所有项目级操作的基础输入。
 *
 * W3 起打开旧项目时先做 scenes→outlines 迁移（幂等），config 的大纲路径前缀与
 * 旧字段名随迁移/归一化自动映射，用户文件只改名不动内容。
 */
export async function loadProjectFromHandle(rootHandle: FileSystemDirectoryHandle): Promise<ProjectSnapshot> {
  const migrated = await migrateScenesToOutlines(rootHandle)
  const rawConfig = await readJson<ProjectConfig>(rootHandle, 'novel.config.json')
  // 旧字段只要存在（哪怕值为 null）就触发写回——null 是合法的「未选大纲」，
  // 按真值判断会让已迁移项目的死字段永远留在盘上。
  const hasLegacyOutlineReference =
    (rawConfig.settings as { activeScenePromptPath?: unknown } | undefined)?.activeScenePromptPath !== undefined
  const config = normalizeProjectConfig(rawConfig)
  // 迁移过或 config 还带旧字段：把归一化结果写回盘（路径前缀已替换、旧字段名被丢弃）
  if (migrated || hasLegacyOutlineReference) {
    await writeJson(rootHandle, 'novel.config.json', config)
  }
  const manifest = await readJson<ProjectManifest>(rootHandle, '.novel/manifest.json')
  const tree = await scanDirectory(rootHandle)

  return {
    id: manifest.projectId,
    name: config.project.name || rootHandle.name,
    rootName: rootHandle.name,
    handle: rootHandle,
    config,
    manifest,
    tree,
    metadata: summarizeProject(tree, config, manifest),
  }
}

/**
 * 旧项目迁移（W3，幂等）：`prompts/scenes/` → `prompts/outlines/`。
 * 文件逐个搬移（内容不动）；目标同名冲突的文件留在原处不覆盖；scenes 目录搬空后删除，
 * 仍有残留（同名冲突）则保留。返回是否发生了搬移。
 */
async function migrateScenesToOutlines(rootHandle: FileSystemDirectoryHandle): Promise<boolean> {
  if (!(await pathExists(rootHandle, LEGACY_SCENES_DIRECTORY, 'directory'))) {
    return false
  }

  await ensureDirectory(rootHandle, OUTLINES_DIRECTORY)
  const legacyFiles = await listFilesInDirectory(rootHandle, LEGACY_SCENES_DIRECTORY)
  let movedAny = false
  for (const filePath of legacyFiles) {
    const targetPath = `${OUTLINES_DIRECTORY}/${filePath.slice(LEGACY_SCENES_DIRECTORY.length + 1)}`
    if (await pathExists(rootHandle, targetPath, 'file')) {
      continue
    }
    await moveProjectTextFile(rootHandle, filePath, targetPath)
    movedAny = true
  }

  // 搬空才删目录；仍有文件（同名冲突未搬）则保留，等用户处理
  const remaining = await listFilesInDirectory(rootHandle, LEGACY_SCENES_DIRECTORY)
  if (remaining.length === 0) {
    await removeFile(rootHandle, LEGACY_SCENES_DIRECTORY)
  }
  return movedAny
}

/**
 * 读取项目中的单个文本文件，并补充格式与更新时间信息，方便页面直接预览。
 */
export async function readProjectFile(snapshot: ProjectSnapshot, path: string): Promise<ProjectFileContent> {
  const fileHandle = await resolveFileHandle(snapshot.handle, path)
  const file = await fileHandle.getFile()
  const content = await file.text()

  return {
    path,
    name: fileHandle.name,
    content,
    format: inferFormat(fileHandle.name),
    updatedAt: new Date(file.lastModified).toISOString(),
  }
}

/**
 * 重新扫描当前项目目录，返回最新文件树。
 * 适合在保存章节、修复目录后刷新测试页列表。
 */
export async function rescanProject(snapshot: ProjectSnapshot): Promise<TreeNode[]> {
  return scanDirectory(snapshot.handle)
}

/**
 * 列出项目内某子目录下所有文件的相对路径（不递归子目录）。
 * 目录不存在时返回空数组，不抛错——调用方按「该目录无内容」处理即可。
 *
 * 相比 rescanProject 的全树扫描，这里只打开单个目标目录遍历，适合「只需要某个子目录文件清单」的场景
 * （如 .novel/sessions/ 下的会话列表），避免无关目录的开销。
 */
export async function listFilesInDirectory(
  rootHandle: FileSystemDirectoryHandle,
  dirPath: string,
): Promise<string[]> {
  let directory: FileSystemDirectoryHandle
  try {
    directory = await resolveDirectoryHandle(rootHandle, dirPath)
  } catch {
    // 目录不存在（或路径非法）视为空
    return []
  }

  const paths: string[] = []
  const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
  for await (const entry of directory.values()) {
    if (entry.kind === 'file') {
      paths.push(`${prefix}${entry.name}`)
    }
  }
  return paths
}

/**
 * 读取 `novel.config.json` 并返回当前项目配置。
 */
export async function readProjectConfig(rootHandle: FileSystemDirectoryHandle): Promise<ProjectConfig> {
  return normalizeProjectConfig(await readJson<ProjectConfig>(rootHandle, 'novel.config.json'))
}

/**
 * 写回 `novel.config.json`，并自动更新项目名兜底值与 `updatedAt` 时间。
 * 调用方只需要传入想保存的配置对象，不需要自己处理这些元信息。
 */
export async function writeProjectConfig(
  rootHandle: FileSystemDirectoryHandle,
  config: ProjectConfig,
): Promise<ProjectConfig> {
  const normalizedConfig = normalizeProjectConfig(config)
  const nextConfig: ProjectConfig = {
    ...normalizedConfig,
    project: {
      ...normalizedConfig.project,
      name: normalizedConfig.project.name || rootHandle.name,
      updatedAt: new Date().toISOString(),
    },
  }

  await writeJson(rootHandle, 'novel.config.json', nextConfig)
  return nextConfig
}

function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  // 旧字段 activeScenePromptPath（W3 前身）读入后即被新字段取代，写回时不再保留。
  const legacySettings = (config.settings ?? {}) as ProjectConfig['settings'] & {
    activeScenePromptPath?: unknown
  }
  const { activeScenePromptPath: legacyScenePromptPath, ...settingsRest } = legacySettings
  return {
    ...DEFAULT_CONFIG,
    ...config,
    project: {
      ...DEFAULT_CONFIG.project,
      ...config.project,
    },
    llm: {
      ...DEFAULT_CONFIG.llm,
      ...config.llm,
      // 思考档位：非法值（含已废弃的 'default'）回退缺省（请求层按 off 解析，零迁移语义）
      reasoningEffort: isReasoningEffort(config.llm?.reasoningEffort)
        ? config.llm.reasoningEffort
        : undefined,
    },
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...config.embedding,
    },
    rerank: {
      ...DEFAULT_CONFIG.rerank,
      ...config.rerank,
      topN: clampInt(config.rerank?.topN, 1, 50, DEFAULT_CONFIG.rerank.topN),
    },
    completion: {
      ...DEFAULT_CONFIG.completion,
      ...config.completion,
      debounceMs: clampInt(config.completion?.debounceMs, 200, 3000, DEFAULT_CONFIG.completion.debounceMs),
      maxTokens: clampInt(config.completion?.maxTokens, 16, 256, DEFAULT_CONFIG.completion.maxTokens),
    },
    search: {
      ...DEFAULT_CONFIG.search,
      ...config.search,
      // 非法档位值回退默认托管档（旧配置无此段时同样落到默认）
      provider: isSearchProvider(config.search?.provider)
        ? config.search.provider
        : DEFAULT_CONFIG.search.provider,
    },
    // 园丁覆盖块（Phase 2 计划 D2/D3）：块缺省 → undefined（全继承，零迁移）；
    // llm 残缺/协议非法整组剔除、permissionPreset 非三档值剔除，均回退继承。
    gardener: normalizeGardenerConfig(config.gardener),
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...settingsRest,
      ragCandidateLimit: clampInt(config.settings?.ragCandidateLimit, 1, 100, DEFAULT_CONFIG.settings.ragCandidateLimit),
      ragContextMaxItems: clampInt(config.settings?.ragContextMaxItems, 1, 50, DEFAULT_CONFIG.settings.ragContextMaxItems),
      conversationTokenLimit: clampInt(config.settings?.conversationTokenLimit, 1000, 200000, DEFAULT_CONFIG.settings.conversationTokenLimit),
      compressionKeepRecentTurns: clampInt(config.settings?.compressionKeepRecentTurns, 1, 20, DEFAULT_CONFIG.settings.compressionKeepRecentTurns),
      // 权限档位：旧配置无此字段回填默认档；非法值同回退
      permissionPreset: isPermissionPreset(config.settings?.permissionPreset)
        ? config.settings.permissionPreset
        : DEFAULT_CONFIG.settings.permissionPreset,
      // agentMaxTurns：0=不限（现行默认）。恰为 8 是旧版出厂默认，视为需要迁移的旧值按 0 处理
      // （用户显式选过其他值如 5 的尊重保留）；缺字段/非法值回退 0。下次保存设置自然落盘为 0。
      agentMaxTurns: normalizeAgentMaxTurns(config.settings?.agentMaxTurns),
      // 大纲路径（W3 改名）：新字段优先，旧字段 activeScenePromptPath 读入映射；
      // prompts/scenes/ 前缀随归一化替换为 outlines/（幂等，旧值随读随映射不丢用户选择）
      activeOutlinePath: remapOutlinePath(
        settingsRest.activeOutlinePath
          ?? legacyScenePromptPath,
      ),
    },
  }
}


/** prompts/scenes/ 路径前缀 → prompts/outlines/；空/非法值归一为 null。 */
function remapOutlinePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) {
    return null
  }
  return path.startsWith(LEGACY_SCENES_DIRECTORY)
    ? `${OUTLINES_DIRECTORY}${path.slice(LEGACY_SCENES_DIRECTORY.length)}`
    : path
}

/** agentMaxTurns 迁移 + 钳制：非有限数 → 0（默认）；8（旧版出厂默认）→ 0；其余钳到 0-50。 */
function normalizeAgentMaxTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  const rounded = Math.round(value)
  if (rounded === 8) {
    return 0
  }
  return Math.min(50, Math.max(0, rounded))
}

/**
 * 园丁覆盖块归一化：块缺省/两覆盖项全被剔除 → undefined（全继承主 Agent）；
 * 否则只保留合法覆盖项。不主动写入默认值（零迁移，D2）。
 */
function normalizeGardenerConfig(gardener: ProjectConfig['gardener']): ProjectConfig['gardener'] {
  if (!gardener || typeof gardener !== 'object') {
    return undefined
  }
  const llm = normalizeGardenerLlm(gardener.llm)
  const permissionPreset = isGardenerPermissionPreset(gardener.permissionPreset)
    ? gardener.permissionPreset
    : undefined
  if (!llm && !permissionPreset) {
    return undefined
  }
  return {
    ...(llm ? { llm } : {}),
    ...(permissionPreset ? { permissionPreset } : {}),
  }
}

/**
 * 园丁 llm 覆盖块校验：四必填（baseUrl/apiKey/model/protocol）任一缺失或协议非法 →
 * 整组剔除回退继承（防半覆盖拼出无效组合，D2）。reasoningEffort 合法才带键——
 * 刻意不用显式 undefined：合成时展开覆盖，undefined 键会遮蔽主配置的思考档。
 */
function normalizeGardenerLlm(
  llm: NonNullable<ProjectConfig['gardener']>['llm'],
): NonNullable<ProjectConfig['gardener']>['llm'] {
  if (!llm || typeof llm !== 'object') {
    return undefined
  }
  const baseUrl = typeof llm.baseUrl === 'string' ? llm.baseUrl.trim() : ''
  const apiKey = typeof llm.apiKey === 'string' ? llm.apiKey : ''
  const model = typeof llm.model === 'string' ? llm.model.trim() : ''
  if (!baseUrl || !model || !isModelProtocol(llm.protocol)) {
    return undefined
  }
  return {
    baseUrl,
    apiKey,
    model,
    protocol: llm.protocol,
    ...(isReasoningEffort(llm.reasoningEffort) ? { reasoningEffort: llm.reasoningEffort } : {}),
  }
}

/**
 * 数值配置钳制：UI 的 min/max 属性只影响步进按钮，手输/手改 JSON 可越界，且 v-model.number
 * 空值会产生 NaN。读写配置的收口处统一钳到合法区间；非有限数回退默认值。边界与设置面板一致。
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

async function hasRequiredElementDirectories(rootHandle: FileSystemDirectoryHandle) {
  const elementDirectories = REQUIRED_DIRECTORY_PATHS.filter((path) => path === 'elements' || path.startsWith('elements/'))

  for (const directoryPath of elementDirectories) {
    if (!(await pathExists(rootHandle, directoryPath, 'directory'))) {
      return false
    }
  }

  return true
}

/**
 * 按相对路径读取项目中的任意文本文件。
 * 适合测试页或后续业务层读取 prompt、章节、要素原文。
 */
export async function readProjectTextFile(rootHandle: FileSystemDirectoryHandle, path: string) {
  return readText(rootHandle, path)
}

export async function getProjectTextFile(rootHandle: FileSystemDirectoryHandle, path: string) {
  const fileHandle = await resolveFileHandle(rootHandle, path)
  return fileHandle.getFile()
}

/**
 * 按相对路径写入项目中的任意文本文件。
 * 路径上的中间目录会自动创建。
 */
export async function writeProjectTextFile(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
  content: string,
) {
  await writeText(rootHandle, path, content)
}

export async function moveProjectTextFile(
  rootHandle: FileSystemDirectoryHandle,
  fromPath: string,
  toPath: string,
) {
  const content = await readText(rootHandle, fromPath)
  await writeText(rootHandle, toPath, content)
  await removeFile(rootHandle, fromPath)

  return content
}

export async function removeProjectFile(rootHandle: FileSystemDirectoryHandle, path: string) {
  await removeFile(rootHandle, path)
}

/**
 * 读取项目中的 `prompts/system.md`。
 */
export async function readSystemPrompt(rootHandle: FileSystemDirectoryHandle) {
  return readText(rootHandle, 'prompts/system.md')
}

/**
 * 读取当前激活的写作大纲（`prompts/outlines/` 下文件）。
 * path 为空、不是 outlines/ 下文件或文件缺失时，返回空字符串，不抛错。
 */
export async function readOutlinePrompt(
  rootHandle: FileSystemDirectoryHandle,
  path?: string | null,
): Promise<string> {
  const outlinePath = path?.trim()

  if (!outlinePath || !outlinePath.startsWith(`${OUTLINES_DIRECTORY}/`)) {
    return ''
  }

  try {
    return await readText(rootHandle, outlinePath)
  } catch {
    return ''
  }
}

/**
 * 读取项目总览 `prompts/NovAI.md`。
 *
 * 该文件是项目级创作记忆，作用类似 Claude Code 的 CLAUDE.md：
 * 每轮 Agent 运行时注入到 system prompt，让模型知道“写到哪了、有哪些人物、哪些伏笔待回收”。
 * 文件缺失时返回空字符串，不抛错（旧项目或被删除的项目）。
 */
export async function readNovAiOverview(rootHandle: FileSystemDirectoryHandle): Promise<string> {
  try {
    return await readText(rootHandle, 'prompts/NovAI.md')
  } catch {
    return ''
  }
}

/**
 * 读取要素库规范 `prompts/ELEMENT.md`（园丁子代理的唯一注入文件）。
 *
 * 只注入园丁、不注入主 Agent（《要素园丁子代理设计》§7.4）；
 * 文件缺失时返回空字符串，不抛错——园丁 prompt 组装层会附「规范缺失」兜底提示。
 */
export async function readElementSchema(rootHandle: FileSystemDirectoryHandle): Promise<string> {
  try {
    return await readText(rootHandle, 'prompts/ELEMENT.md')
  } catch {
    return ''
  }
}

/**
 * 从文件树中找到第一个可直接预览的文本文件路径。
 * 适合项目激活时给测试页提供一个默认打开目标。
 */
export function findFirstReadableFile(tree: TreeNode[]): string | null {
  const stack = [...tree]

  while (stack.length > 0) {
    const current = stack.shift()

    if (!current) {
      continue
    }

    if (current.kind === 'file' && TEXT_FILE_EXTENSIONS.some((extension) => current.name.endsWith(extension))) {
      return current.path
    }

    if (current.children?.length) {
      stack.unshift(...current.children)
    }
  }

  return null
}

function inferFormat(name: string): ProjectFileContent['format'] {
  if (name.endsWith('.md')) {
    return 'markdown'
  }

  if (name.endsWith('.json')) {
    return 'json'
  }

  return 'text'
}

async function scanDirectory(
  rootHandle: FileSystemDirectoryHandle,
  parentPath = '',
): Promise<TreeNode[]> {
  const entries: TreeNode[] = []

  for await (const entry of rootHandle.values()) {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name

    if (isDirectoryHandle(entry)) {
      entries.push({
        name: entry.name,
        path,
        kind: 'directory',
        // 文件树在这里一次性递归展开，测试页后面就只负责展示和选择。
        children: await scanDirectory(entry, path),
      })
      continue
    }

    entries.push({
      name: entry.name,
      path,
      kind: 'file',
    })
  }

  return sortTree(entries)
}

function isDirectoryHandle(entry: FileSystemHandle): entry is FileSystemDirectoryHandle {
  return entry.kind === 'directory'
}

function sortTree(entries: TreeNode[]) {
  return entries.sort((left, right) => {
    const leftRootOrder = ROOT_DIRECTORY_ORDER.indexOf(left.name)
    const rightRootOrder = ROOT_DIRECTORY_ORDER.indexOf(right.name)

    if (leftRootOrder !== -1 || rightRootOrder !== -1) {
      if (leftRootOrder === -1) {
        return 1
      }

      if (rightRootOrder === -1) {
        return -1
      }

      if (leftRootOrder !== rightRootOrder) {
        return leftRootOrder - rightRootOrder
      }
    }

    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
}

async function ensureDirectory(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true })
  }
}

async function pathExists(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
  kind: 'file' | 'directory',
) {
  try {
    if (kind === 'file') {
      await resolveFileHandle(rootHandle, path)
    } else {
      await resolveDirectoryHandle(rootHandle, path)
    }

    return true
  } catch {
    return false
  }
}

async function isJsonFileValid<T>(rootHandle: FileSystemDirectoryHandle, path: string) {
  try {
    await readJson<T>(rootHandle, path)
    return true
  } catch {
    return false
  }
}

async function resolveProjectNameForRepair(rootHandle: FileSystemDirectoryHandle) {
  try {
    const config = await readJson<ProjectConfig>(rootHandle, 'novel.config.json')
    const configName = config.project.name.trim()

    if (configName) {
      return configName
    }
  } catch {
    // Fall back to the directory name when config is missing or invalid.
  }

  return rootHandle.name
}

async function writeText(rootHandle: FileSystemDirectoryHandle, path: string, content: string) {
  const fileHandle = await ensureFileHandle(rootHandle, path)
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function writeJson(rootHandle: FileSystemDirectoryHandle, path: string, value: unknown) {
  await writeText(rootHandle, path, JSON.stringify(value, null, 2))
}

async function readJson<T>(rootHandle: FileSystemDirectoryHandle, path: string): Promise<T> {
  const content = await readText(rootHandle, path)
  return JSON.parse(content) as T
}

async function readText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const fileHandle = await resolveFileHandle(rootHandle, path)
  const file = await fileHandle.getFile()
  return file.text()
}

async function removeFile(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  const parentHandle = await resolveDirectoryHandle(rootHandle, segments.join('/'))
  await parentHandle.removeEntry(fileName)
}

async function ensureFileHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true })
  }

  return current.getFileHandle(fileName, { create: true })
}

async function resolveFileHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
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

async function resolveDirectoryHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current
}

function summarizeProject(
  tree: TreeNode[],
  config: ProjectConfig,
  manifest: ProjectManifest,
): RecentProject {
  const chapterDirectory = tree.find((node) => node.path === 'chapters')
  const elementDirectory = tree.find((node) => node.path === 'elements')
  const updatedAt = config.project.updatedAt || manifest.lastOpenedAt || new Date().toISOString()

  return {
    id: manifest.projectId,
    name: config.project.name,
    updatedAt,
    chapterCount: countFiles(chapterDirectory),
    elementCount: countFiles(elementDirectory),
    wordCount: 0,
  }
}

function countFiles(node?: TreeNode): number {
  if (!node) {
    return 0
  }

  if (node.kind === 'file') {
    return 1
  }

  return (node.children ?? []).reduce((total, child) => total + countFiles(child), 0)
}

function createProjectId() {
  const random = Math.random().toString(36).slice(2, 8)
  return `novel-${Date.now()}-${random}`
}
