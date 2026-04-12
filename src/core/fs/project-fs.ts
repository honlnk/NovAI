import { createDefaultConfig, createDefaultManifest, DEFAULT_SCENE_PROMPT, DEFAULT_SYSTEM_PROMPT } from '../project/defaults'

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
  'elements/timeline',
  'elements/plots',
  'elements/worldbuilding',
  'prompts',
  'prompts/scenes',
  '.novel',
] as const

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

  await ensureDirectory(rootHandle, 'chapters')
  await ensureDirectory(rootHandle, 'elements/characters')
  await ensureDirectory(rootHandle, 'elements/locations')
  await ensureDirectory(rootHandle, 'elements/timeline')
  await ensureDirectory(rootHandle, 'elements/plots')
  await ensureDirectory(rootHandle, 'elements/worldbuilding')
  await ensureDirectory(rootHandle, 'prompts/scenes')
  await ensureDirectory(rootHandle, '.novel')

  await writeJson(rootHandle, 'novel.config.json', createDefaultConfig(projectName))
  await writeJson(rootHandle, '.novel/manifest.json', createDefaultManifest(projectId))
  await writeText(rootHandle, 'prompts/system.md', DEFAULT_SYSTEM_PROMPT)
  await writeText(rootHandle, 'prompts/scenes/scene-001.md', DEFAULT_SCENE_PROMPT)

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

  if (!(await pathExists(rootHandle, 'prompts/scenes', 'directory'))) {
    issues.push('missing-prompts-scenes')
  }

  if (!(await pathExists(rootHandle, 'chapters', 'directory'))) {
    issues.push('missing-chapters')
  }

  if (!(await pathExists(rootHandle, 'elements', 'directory'))) {
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

  if (!(await pathExists(rootHandle, 'prompts/scenes/scene-001.md', 'file'))) {
    await writeText(rootHandle, 'prompts/scenes/scene-001.md', DEFAULT_SCENE_PROMPT)
  }

  return loadProjectFromHandle(rootHandle)
}

/**
 * 从一个已知合法的目录句柄中读取配置、清单和文件树，并组装成项目快照。
 * 这是测试页后续所有项目级操作的基础输入。
 */
export async function loadProjectFromHandle(rootHandle: FileSystemDirectoryHandle): Promise<ProjectSnapshot> {
  const config = await readJson<ProjectConfig>(rootHandle, 'novel.config.json')
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
 * 读取 `novel.config.json` 并返回当前项目配置。
 */
export async function readProjectConfig(rootHandle: FileSystemDirectoryHandle): Promise<ProjectConfig> {
  return readJson<ProjectConfig>(rootHandle, 'novel.config.json')
}

/**
 * 写回 `novel.config.json`，并自动更新项目名兜底值与 `updatedAt` 时间。
 * 调用方只需要传入想保存的配置对象，不需要自己处理这些元信息。
 */
export async function writeProjectConfig(
  rootHandle: FileSystemDirectoryHandle,
  config: ProjectConfig,
): Promise<ProjectConfig> {
  const nextConfig: ProjectConfig = {
    ...config,
    project: {
      ...config.project,
      name: config.project.name || rootHandle.name,
      updatedAt: new Date().toISOString(),
    },
  }

  await writeJson(rootHandle, 'novel.config.json', nextConfig)
  return nextConfig
}

/**
 * 按相对路径读取项目中的任意文本文件。
 * 适合测试页或后续业务层读取 prompt、章节、要素原文。
 */
export async function readProjectTextFile(rootHandle: FileSystemDirectoryHandle, path: string) {
  return readText(rootHandle, path)
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

/**
 * 读取项目中的 `prompts/system.md`。
 */
export async function readSystemPrompt(rootHandle: FileSystemDirectoryHandle) {
  return readText(rootHandle, 'prompts/system.md')
}

/**
 * 写回项目中的 `prompts/system.md`。
 */
export async function writeSystemPrompt(rootHandle: FileSystemDirectoryHandle, content: string) {
  await writeText(rootHandle, 'prompts/system.md', content)
}

/**
 * 将生成结果保存为章节 Markdown 文件，并返回最终采用的文件名。
 * 如果调用方没有提供合法名称，这里会自动生成一个可落盘的默认值。
 */
export async function writeChapterFile(
  rootHandle: FileSystemDirectoryHandle,
  fileName: string,
  markdown: string,
) {
  // 测试页允许直接输入文件名，这里统一兜底成稳定的 .md 文件名。
  const normalizedName = normalizeChapterFileName(fileName)
  await writeText(rootHandle, `chapters/${normalizedName}`, markdown)
  return normalizedName
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

function normalizeChapterFileName(fileName: string) {
  const trimmed = fileName.trim()

  if (!trimmed) {
    const now = new Date()
    const stamp = [
      now.getFullYear(),
      `${now.getMonth() + 1}`.padStart(2, '0'),
      `${now.getDate()}`.padStart(2, '0'),
      `${now.getHours()}`.padStart(2, '0'),
      `${now.getMinutes()}`.padStart(2, '0'),
      `${now.getSeconds()}`.padStart(2, '0'),
    ].join('')
    return `chapter-${stamp}.md`
  }

  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
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
  const updatedAt = config.project.updatedAt || manifest.lastOpenedAt || new Date().toISOString()

  return {
    id: manifest.projectId,
    name: config.project.name,
    updatedAt,
    chapterCount: countFiles(chapterDirectory),
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
