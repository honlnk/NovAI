import { createDefaultConfig, createDefaultManifest, DEFAULT_SCENE_PROMPT, DEFAULT_SYSTEM_PROMPT } from '../project/defaults'

import type {
  ProjectConfig,
  ProjectFileContent,
  ProjectManifest,
  ProjectSnapshot,
  RecentProject,
  TreeNode,
} from '../../types/project'

const TEXT_FILE_EXTENSIONS = ['.md', '.json', '.txt']
const ROOT_DIRECTORY_ORDER = ['chapters', 'elements', 'prompts', '.novel']

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

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

export async function openProject(): Promise<ProjectSnapshot> {
  const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
  return loadProjectFromHandle(rootHandle)
}

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

export async function rescanProject(snapshot: ProjectSnapshot): Promise<TreeNode[]> {
  return scanDirectory(snapshot.handle)
}

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
