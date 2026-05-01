import { isNotFoundError, normalizeProjectDirectoryPath } from './path'
import type {
  FindFilesInput,
  FindFilesOutput,
  ListDirectoryEntry,
  ListDirectoryInput,
  ListDirectoryOutput,
  ToolDefinition,
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
    const directoryPath = input.path ?? ''
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
    const filenames: string[] = []
    let truncated = false

    for await (const filePath of walkFiles(directoryHandle, searchPath, Boolean(input.includeHidden))) {
      const relativeToSearchPath = searchPath ? filePath.slice(searchPath.length + 1) : filePath

      if (!matcher(filePath) && !matcher(relativeToSearchPath)) {
        continue
      }

      if (filenames.length >= limit) {
        truncated = true
        break
      }

      filenames.push(filePath)
    }

    return {
      pattern: input.pattern,
      path: searchPath,
      filenames: filenames.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')),
      numFiles: filenames.length,
      truncated,
    }
  },
  summarizeInput(input) {
    const target = input.path || '项目根目录'
    return `按模式 ${input.pattern} 在 ${target} 查找文件`
  },
  summarizeOutput(output) {
    const target = output.path || '项目根目录'
    return output.truncated
      ? `已在 ${target} 找到 ${output.numFiles} 个文件，结果已截断`
      : `已在 ${target} 找到 ${output.numFiles} 个文件`
  },
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

async function* walkFiles(
  directoryHandle: FileSystemDirectoryHandle,
  directoryPath: string,
  includeHidden: boolean,
): AsyncGenerator<string> {
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
      yield entryPath
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

function createGlobMatcher(pattern: string) {
  const normalizedPattern = pattern.startsWith('./') ? pattern.slice(2) : pattern
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`)

  return (path: string) => regex.test(path)
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
