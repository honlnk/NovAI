import { createSpillFileId, SPILL_DIR } from '../agent/spill'
import { writeProjectTextFile } from '../fs/project-fs'
import { isNotFoundError, normalizeProjectDirectoryPath } from './path'
import { createGlobMatcher, walkFiles } from './directory-tools'
import { assertReadableDirectoryPath } from './file-tools/common'
import { truncateLongLine } from './file-tools/read-file'
import type { SearchFilesInput, SearchFilesOutput, ToolDefinition, ToolRuntime } from './types'

/**
 * 按文件内容搜索（D7-D11）：「林婉儿在哪几章出现」这类精确人名/词组的正文搜索。
 * 默认字面匹配（正则对模型构造参数是负担，需要时显式 regex: true）、默认带 2 行上下文
 * （小说里光看匹配行往往不够，要看前后句才知道人物在这章干了什么）——两点都是
 * 针对小说场景的定制，与代码 grep 的关键差异。只读工具，不进确认链。
 */

const DEFAULT_CONTEXT_LINES = 2
const MAX_CONTEXT_LINES = 5
const DEFAULT_MATCH_LIMIT = 100
const MAX_MATCH_LIMIT = 500

/** 单个匹配的渲染材料：匹配行 + 截断后的上下文窗口（含匹配行自身，带行号）。 */
type TextMatch = {
  path: string
  lineNumber: number
  line: string
  /** [行号, 行内容] 对；contextLines=0 时为空数组 */
  context: Array<[number, string]>
}

export const searchFilesTool: ToolDefinition<'SearchFiles', SearchFilesInput, SearchFilesOutput> = {
  name: 'SearchFiles',
  description: '按文件内容搜索项目中的文本，返回匹配行及前后上下文，按文件分组。默认字面匹配；设 regex: true 启用正则。',
  validateInput(input) {
    const value = asRecord(input)
    const query = readString(value.query, 'SearchFiles.query')

    if (!query) {
      throw new Error('SearchFiles.query 不能为空')
    }

    const regex = typeof value.regex === 'boolean' ? value.regex : false

    if (regex) {
      try {
        new RegExp(query)
      } catch (error) {
        throw new Error(`SearchFiles.query 不是合法的 JS 正则：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const path = normalizeProjectDirectoryPath(readOptionalString(value.path, 'SearchFiles.path'))
    // 目录版读边界（D11）：.novel/ 整体禁读，.novel/spill/ 放行（可显式在 spill 内搜索）
    assertReadableDirectoryPath(path, 'SearchFiles.path')

    const include = readOptionalString(value.include, 'SearchFiles.include')

    if (include !== undefined) {
      validateInclude(include)
    }

    return {
      query,
      ...(path ? { path } : {}),
      ...(include !== undefined ? { include } : {}),
      regex,
      contextLines: readContextLines(value.contextLines),
      limit: readLimit(value.limit),
    }
  },
  async run(input, runtime) {
    const searchPath = input.path ?? ''

    let directoryHandle: FileSystemDirectoryHandle

    try {
      directoryHandle = await resolveDirectoryHandle(runtime.project.handle, searchPath)
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(`搜索目录不存在：${searchPath || '项目根目录'}`)
      }

      throw error
    }

    const includeMatcher = input.include ? createGlobMatcher(input.include) : undefined
    const matches = await collectMatches(directoryHandle, searchPath, includeMatcher, input)
    const truncated = matches.length > input.limit
    const shown = truncated ? matches.slice(0, input.limit) : matches

    // 超限：完整结果落 spill（D10），上下文只留前 limit 处预览；spill 写失败降级为无指引截断
    let spillPath: string | undefined

    if (truncated) {
      spillPath = await writeSearchSpill(runtime, input, matches)
    }

    return {
      query: input.query,
      path: searchPath,
      include: input.include,
      regex: input.regex,
      contextLines: input.contextLines,
      content: renderMatches(shown),
      shownMatches: shown.length,
      totalMatches: matches.length,
      truncated,
      ...(spillPath ? { spillPath } : {}),
    }
  },
  summarizeInput(input) {
    const target = input.path || '项目根目录'
    const scope = input.include ? `（只搜 ${input.include}）` : ''
    return `在 ${target} 搜索「${input.query}」${scope}`
  },
  summarizeOutput(output) {
    if (output.totalMatches === 0) {
      return `搜索「${output.query}」没有找到匹配`
    }

    return output.truncated
      ? `搜索「${output.query}」共找到 ${output.totalMatches} 处匹配，显示前 ${output.shownMatches} 处`
      : `搜索「${output.query}」找到 ${output.totalMatches} 处匹配`
  },
}

/**
 * 遍历搜索范围内的文件，收集全部匹配（全量扫描：小说项目体量小，计划「明确不做」第 5 条）。
 * 隐藏目录（.novel、.novai 等 . 开头条目）默认跳过；.novel/spill/ 只有显式传 path 才进得来。
 */
async function collectMatches(
  directoryHandle: FileSystemDirectoryHandle,
  searchPath: string,
  includeMatcher: ((path: string, relativeToSearchPath: string) => boolean) | undefined,
  input: Pick<SearchFilesInput, 'query' | 'regex' | 'contextLines'>,
): Promise<TextMatch[]> {
  const matches: TextMatch[] = []
  // 字面匹配用 includes；正则用 search（无 lastIndex 状态副作用，多次调用行为一致）
  const regex = input.regex ? new RegExp(input.query) : undefined

  for await (const entry of walkFiles(directoryHandle, searchPath)) {
    const relativeToSearchPath = searchPath ? entry.path.slice(searchPath.length + 1) : entry.path

    if (includeMatcher && !includeMatcher(entry.path, relativeToSearchPath)) {
      continue
    }

    const file = await (await resolveFileHandle(directoryHandle, searchPath, entry.path)).getFile()
    const content = await file.text()

    if (!content) {
      continue
    }

    const lines = content.replace(/\r\n/g, '\n').split('\n')

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]

      if (regex ? line.search(regex) === -1 : !line.includes(input.query)) {
        continue
      }

      matches.push({
        path: entry.path,
        lineNumber: index + 1,
        line: truncateLongLine(line),
        context: collectContext(lines, index, input.contextLines),
      })
    }
  }

  return matches
}

/** 抓匹配行的上下文窗口（前后各 contextLines 行，含匹配行自身），逐行截断。 */
function collectContext(lines: string[], matchIndex: number, contextLines: number): Array<[number, string]> {
  if (contextLines <= 0) {
    return []
  }

  const start = Math.max(0, matchIndex - contextLines)
  const end = Math.min(lines.length - 1, matchIndex + contextLines)
  const context: Array<[number, string]> = []

  for (let index = start; index <= end; index += 1) {
    context.push([index + 1, truncateLongLine(lines[index])])
  }

  return context
}

/** D8 输出格式：按文件分组（首见序），组头是文件路径，每匹配一行 Line N + 缩进上下文块。 */
export function renderMatches(matches: TextMatch[]): string {
  const byFile = new Map<string, TextMatch[]>()

  for (const match of matches) {
    const group = byFile.get(match.path)

    if (group) {
      group.push(match)
    } else {
      byFile.set(match.path, [match])
    }
  }

  const sections: string[] = []

  for (const [path, group] of byFile) {
    const blocks = group.map((match) => [
      `Line ${match.lineNumber}: ${match.line}`,
      ...match.context.map(([lineNumber, line]) => `  ${String(lineNumber).padStart(4, ' ')} | ${line}`),
    ].join('\n'))

    sections.push(`${path}\n${blocks.join('\n')}`)
  }

  return sections.join('\n\n')
}

/** 超限完整结果落 spill（D10）：渲染全部匹配（header + 分组正文），失败返回 undefined。 */
async function writeSearchSpill(
  runtime: Pick<ToolRuntime, 'project'>,
  input: SearchFilesInput,
  matches: TextMatch[],
): Promise<string | undefined> {
  const path = `${SPILL_DIR}/search-files-${createSpillFileId()}.txt`
  const content = [
    `query: ${input.query}${input.regex ? '（正则）' : ''}`,
    `path: ${input.path || '(项目根目录)'}`,
    `共 ${matches.length} 处匹配：`,
    '',
    renderMatches(matches),
  ].join('\n')

  try {
    await writeProjectTextFile(runtime.project.handle, path, content)
    return path
  } catch {
    return undefined
  }
}

/** include 校验（D11，对齐 dsh grep 的 validateInclude）：拒绝空串、! 取反、逗号列表（花括号内逗号允许）。 */
function validateInclude(include: string) {
  if (!include.trim()) {
    throw new Error('SearchFiles.include 必须是非空 glob')
  }

  if (include.startsWith('!')) {
    throw new Error('SearchFiles.include 只支持正向 glob 过滤，不支持 ! 取反')
  }

  let braceDepth = 0

  for (const char of include) {
    if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === ',' && braceDepth === 0) {
      throw new Error('SearchFiles.include 必须是单个 glob，不支持逗号列表（可用 {a,b} 花括号写法）')
    }
  }
}

function readContextLines(value: unknown) {
  if (value === undefined) {
    return DEFAULT_CONTEXT_LINES
  }

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > MAX_CONTEXT_LINES) {
    throw new Error(`SearchFiles.contextLines 必须是 0-${MAX_CONTEXT_LINES} 的整数`)
  }

  return value
}

function readLimit(value: unknown) {
  if (value === undefined) {
    return DEFAULT_MATCH_LIMIT
  }

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    throw new Error('SearchFiles.limit 必须是正整数')
  }

  return Math.min(value, MAX_MATCH_LIMIT)
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

function readString(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`)
  }

  return value
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

async function resolveDirectoryHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current
}

/** 从搜索根逐级解析匹配文件的句柄（entry.path 是项目根相对全路径，搜索根可能是其子目录）。 */
async function resolveFileHandle(
  searchRootHandle: FileSystemDirectoryHandle,
  searchPath: string,
  filePath: string,
): Promise<FileSystemFileHandle> {
  const relative = searchPath && filePath.startsWith(`${searchPath}/`)
    ? filePath.slice(searchPath.length + 1)
    : filePath
  const segments = relative.split('/').filter(Boolean)
  const fileName = segments.pop()
  let current = searchRootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current.getFileHandle(fileName!)
}
