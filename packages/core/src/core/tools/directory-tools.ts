import { isNotFoundError, normalizeProjectDirectoryPath } from './path'
import { createSpillFileId, SPILL_DIR } from '../agent/spill'
import { writeProjectTextFile } from '../fs/project-fs'
import type {
  FindFilesInput,
  FindFilesOutput,
  ListDirectoryEntry,
  ListDirectoryInput,
  ListDirectoryOutput,
  ToolDefinition,
  ToolRuntime,
} from './types'

const DEFAULT_GLOB_LIMIT = 100
const MAX_GLOB_LIMIT = 500

export const listDirectoryTool: ToolDefinition<'ListDirectory', ListDirectoryInput, ListDirectoryOutput> = {
  name: 'ListDirectory',
  description: '查看当前小说项目中某个目录的直接文件结构。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectDirectoryPath(readOptionalString(value.path, 'ListDirectory.path'))

    return {
      path: path || undefined,
      showHidden: typeof value.showHidden === 'boolean' ? value.showHidden : false,
    }
  },
  async run(input, runtime) {
    const directoryPath = normalizeDirectoryRuntimePath(input.path ?? '', runtime.project)
    let directoryHandle: FileSystemDirectoryHandle

    try {
      directoryHandle = await resolveDirectoryHandle(runtime.project.handle, directoryPath)
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }

      throw new Error(getMissingDirectoryMessage(directoryPath))
    }

    const entries: ListDirectoryEntry[] = []

    for await (const entry of directoryHandle.values()) {
      const hidden = entry.name.startsWith('.')

      if (hidden && !input.showHidden) {
        continue
      }

      entries.push({
        name: entry.name,
        path: directoryPath ? `${directoryPath}/${entry.name}` : entry.name,
        kind: entry.kind,
        hidden,
      })
    }

    return {
      path: directoryPath,
      entries: sortEntries(entries),
    }
  },
  summarizeInput(input) {
    const target = input.path || '项目根目录'
    return input.showHidden
      ? `查看 ${target} 的目录结构，包括隐藏项`
      : `查看 ${target} 的目录结构`
  },
  summarizeOutput(output) {
    const target = output.path || '项目根目录'
    return `已查看 ${target}，共 ${output.entries.length} 个条目`
  },
}

function normalizeDirectoryRuntimePath(path: string, project: { name: string; rootName: string }) {
  if (path === project.name || path === project.rootName) {
    return ''
  }

  return path
}

function getMissingDirectoryMessage(path: string) {
  const target = path || '项目根目录'

  return `目录不存在：${target}。如果你要新建文件，不需要先创建目录，直接使用 CreateFile 写入目标文件即可，父目录会自动创建；如果你要查找已有文件，请先查看上级目录，或使用 FindFiles 按文件名/路径模式查找。`
}

export const findFilesTool: ToolDefinition<'FindFiles', FindFilesInput, FindFilesOutput> = {
  name: 'FindFiles',
  description: '按 glob 模式查找当前小说项目中的文件路径。',
  validateInput(input) {
    const value = asRecord(input)
    const pattern = readRequiredString(value.pattern, 'FindFiles.pattern').trim().replace(/\\/g, '/')
    const path = normalizeProjectDirectoryPath(readOptionalString(value.path, 'FindFiles.path'))

    if (!pattern) {
      throw new Error('FindFiles.pattern 不能为空')
    }

    validateGlobPattern(pattern)

    return {
      pattern,
      path: path || undefined,
      includeHidden: typeof value.includeHidden === 'boolean' ? value.includeHidden : false,
      limit: readLimit(value.limit),
    }
  },
  async run(input, runtime) {
    const searchPath = input.path ?? ''
    const directoryHandle = await resolveDirectoryHandle(runtime.project.handle, searchPath)
    const matcher = createGlobMatcher(input.pattern)
    const limit = input.limit ?? DEFAULT_GLOB_LIMIT

    // 遍历时一并收集 mtime，结果按修改时间降序（D3）；同 mtime 按路径字典序兜底保证确定性
    const matches: Array<{ path: string; lastModified: number }> = []

    for await (const entry of walkFiles(directoryHandle, searchPath, Boolean(input.includeHidden))) {
      const relativeToSearchPath = searchPath ? entry.path.slice(searchPath.length + 1) : entry.path

      if (!matcher(entry.path, relativeToSearchPath)) {
        continue
      }

      matches.push(entry)
    }

    matches.sort((left, right) =>
      right.lastModified - left.lastModified || left.path.localeCompare(right.path, 'zh-Hans-CN'),
    )

    const filenames = matches.map((match) => match.path)

    if (filenames.length <= limit) {
      return {
        pattern: input.pattern,
        path: searchPath,
        filenames,
        numFiles: filenames.length,
        truncated: false,
      }
    }

    // 超限：跨顶层目录轮转采样（D4）+ 完整结果落 spill（D5）
    const sample = sampleAcrossTopLevel(filenames, limit, searchPath)
    const spillPath = await writeFindFilesSpill(runtime, input.pattern, searchPath, filenames)

    return {
      pattern: input.pattern,
      path: searchPath,
      filenames: sample.items,
      numFiles: sample.items.length,
      truncated: true,
      totalMatches: filenames.length,
      sampledTopLevelDirs: sample.shown,
      totalTopLevelDirs: sample.total,
      ...(spillPath ? { spillPath } : {}),
    }
  },
  summarizeInput(input) {
    const target = input.path || '项目根目录'
    return `按模式 ${input.pattern} 在 ${target} 查找文件`
  },
  summarizeOutput(output) {
    const target = output.path || '项目根目录'

    if (output.truncated) {
      return `已在 ${target} 找到 ${output.totalMatches} 个文件，采样展示 ${output.numFiles} 个`
    }

    return `已在 ${target} 找到 ${output.numFiles} 个文件`
  },
}

/**
 * 超限采样（D4，参照 dsh glob 的 sampleAcrossTopLevel）：按搜索根下的顶层目录分组轮转取样，
 * 保证每个子目录都有代表，而不是只取 mtime 序头部。组内保持传入顺序（mtime 降序）。
 */
export function sampleAcrossTopLevel(
  paths: string[],
  maxItems: number,
  searchPath: string,
): { items: string[]; shown: number; total: number } {
  const prefix = searchPath ? `${searchPath}/` : ''
  const groups = new Map<string, string[]>()

  for (const path of paths) {
    const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    const cut = relative.indexOf('/')
    const key = cut === -1 ? relative : relative.slice(0, cut)
    const group = groups.get(key)

    if (group) {
      group.push(path)
    } else {
      groups.set(key, [path])
    }
  }

  const taken = new Map<string, string[]>()
  let active = [...groups.entries()].map(([key, items]) => ({ key, items, index: 0 }))
  let count = 0

  while (active.length > 0 && count < maxItems) {
    const nextActive: Array<{ key: string; items: string[]; index: number }> = []

    for (const group of active) {
      if (count >= maxItems) {
        break
      }

      count += 1
      const bucket = taken.get(group.key)

      if (bucket) {
        bucket.push(group.items[group.index])
      } else {
        taken.set(group.key, [group.items[group.index]])
      }

      const nextIndex = group.index + 1

      if (nextIndex < group.items.length) {
        nextActive.push({ key: group.key, items: group.items, index: nextIndex })
      }
    }

    active = nextActive
  }

  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size }
}

/** 超限完整结果落 spill（D5）：失败时返回 undefined，调用方降级为无指引的截断提示。 */
async function writeFindFilesSpill(
  runtime: ToolRuntime,
  pattern: string,
  searchPath: string,
  filenames: string[],
): Promise<string | undefined> {
  const path = `${SPILL_DIR}/find-files-${createSpillFileId()}.txt`
  const content = [
    `pattern: ${pattern}`,
    `path: ${searchPath || '(项目根目录)'}`,
    `共 ${filenames.length} 个匹配（按修改时间降序）：`,
    '',
    ...filenames,
  ].join('\n')

  try {
    await writeProjectTextFile(runtime.project.handle, path, content)
    return path
  } catch {
    return undefined
  }
}

function asRecord(input: unknown) {
  if (input === undefined || input === null) {
    return {}
  }

  if (typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}

function readOptionalString(value: unknown, label: string) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`)
  }

  return value
}

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`)
  }

  return value
}

function readLimit(value: unknown) {
  if (value === undefined) {
    return DEFAULT_GLOB_LIMIT
  }

  if (!Number.isInteger(value) || typeof value !== 'number') {
    throw new Error('FindFiles.limit 必须是整数')
  }

  if (value < 1) {
    throw new Error('FindFiles.limit 必须大于 0')
  }

  return Math.min(value, MAX_GLOB_LIMIT)
}

async function resolveDirectoryHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current
}

function sortEntries<TEntry extends { name: string; kind: 'file' | 'directory' }>(entries: TEntry[]) {
  return entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
}

/** 遍历产出文件路径 + 修改时间（mtime 排序与采样都依赖它）；SearchFiles 复用遍历、忽略 mtime。 */
export async function* walkFiles(
  directoryHandle: FileSystemDirectoryHandle,
  directoryPath: string,
  includeHidden: boolean,
): AsyncGenerator<{ path: string; lastModified: number }> {
  const entries: FileSystemHandle[] = []

  for await (const entry of directoryHandle.values()) {
    if (!includeHidden && entry.name.startsWith('.')) {
      continue
    }

    entries.push(entry)
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })

  for (const entry of entries) {
    const entryPath = directoryPath ? `${directoryPath}/${entry.name}` : entry.name

    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile()
      yield { path: entryPath, lastModified: file.lastModified }
      continue
    }

    yield* walkFiles(entry as FileSystemDirectoryHandle, entryPath, includeHidden)
  }
}

function validateGlobPattern(pattern: string) {
  if (pattern.startsWith('/') || /^[a-zA-Z]:\//.test(pattern)) {
    throw new Error('FindFiles.pattern 只能使用项目内的相对路径模式')
  }

  const segments = pattern.split('/').filter(Boolean)

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('FindFiles.pattern 不能包含 . 或 .. 路径片段')
  }
}

/**
 * 模式匹配器（D6 对齐 dsh glob）：不含 `/` 的模式匹配任意深度的 basename
 * （`*.txt` 搜全树文件名）；含 `/` 的模式锚定路径深度（匹配项目全路径或相对搜索根的路径）。
 */
/** 统一双参签名：path = 项目根相对全路径，relativeToSearchPath = 相对搜索根的路径。 */
type GlobMatcher = (path: string, relativeToSearchPath: string) => boolean

/** SearchFiles 的 include 过滤复用同一套 glob 语义（无 `/` 匹配任意深度 basename）。 */
export function createGlobMatcher(pattern: string): GlobMatcher {
  const normalizedPattern = pattern.startsWith('./') ? pattern.slice(2) : pattern
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`)

  if (normalizedPattern.includes('/')) {
    return (path, relativeToSearchPath) => regex.test(path) || regex.test(relativeToSearchPath)
  }

  return (path) => {
    const cut = path.lastIndexOf('/')
    return regex.test(cut === -1 ? path : path.slice(cut + 1))
  }
}

function globToRegexSource(pattern: string) {
  let source = ''

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const nextChar = pattern[index + 1]

    if (char === '*' && nextChar === '*') {
      const afterNextChar = pattern[index + 2]

      if (afterNextChar === '/') {
        source += '(?:.*/)?'
        index += 2
        continue
      }

      source += '.*'
      index += 1
      continue
    }

    if (char === '*') {
      source += '[^/]*'
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += escapeRegexChar(char)
  }

  return source
}

function escapeRegexChar(char: string) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
}
