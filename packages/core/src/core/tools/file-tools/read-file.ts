import { getProjectTextFile } from '../../fs/project-fs'
import type { ReadFileInput, ReadFileOutput, ToolDefinition } from '../types'
import { asRecord, assertReadableDocumentPath, readString } from './common'
import { createReadFileState } from './read-file-state'
import { normalizeProjectPath } from '../path'

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_LIMIT = 2000
const MAX_FULL_READ_BYTES = 512 * 1024

/** 第二道闸：单行字符截断（dsh READ_MAX_LINE_LENGTH=2000），防某一行几万字撑爆单次返回。 */
export const READ_MAX_LINE_LENGTH = 2000
/**
 * 第三道闸：单次返回总字节封顶（dsh READ_MAX_BYTES=50KB，UTF-8 字节口径）。
 * 中文一字 ≈ 3 字节，50KB ≈ 1.7 万中文字 ≈ 一次读 1.5~2.5 章正文。
 * 有了它 ReadFile 结果天然不会大到要 spill，spill 文件才敢放行可读而不怕循环。
 */
export const READ_MAX_BYTES = 50 * 1024

const textEncoder = new TextEncoder()

export const readFileTool: ToolDefinition<'ReadFile', ReadFileInput, ReadFileOutput> = {
  name: 'ReadFile',
  description: '读取当前小说项目中的文本文件，返回带行号的内容。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'ReadFile.path'))
    // .novel/ 内部数据（会话、日志）不可读；唯独 .novel/spill/ 放行——
    // spill 省略标记指引模型分段读回完整内容，这个口子就是取回通道。
    // 三道闸（行分页/单行截断/字节封顶）保证读回结果不会再大到要 spill，不会循环。
    assertReadableDocumentPath(path, 'ReadFile.path')

    const offset = readOptionalPositiveInteger(value.offset, 'ReadFile.offset')
    const limit = readOptionalPositiveInteger(value.limit, 'ReadFile.limit')

    return {
      path,
      offset,
      limit,
    }
  },
  async run(input, runtime) {
    const file = await getProjectTextFile(runtime.project.handle, input.path)
    const shouldReadWholeFile = input.offset === undefined && input.limit === undefined

    if (shouldReadWholeFile && file.size > MAX_FULL_READ_BYTES) {
      throw new Error(
        `文件 ${input.path} 大小为 ${formatBytes(file.size)}，超过 ReadFile 单次完整读取上限 ${formatBytes(MAX_FULL_READ_BYTES)}；请使用 offset 和 limit 分段读取，或先用 FindFiles 定位更具体的文件。`,
      )
    }

    const content = await file.text()
    const readFileState = createReadFileState(input.path, content, file)
    runtime.readFileStates?.set(input.path, readFileState)

    const lines = splitLines(content)
    const startLine = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_READ_LIMIT
    const startIndex = Math.max(startLine - 1, 0)
    const selectedLines = lines.slice(startIndex, startIndex + limit)
    const empty = content.length === 0
    const offsetBeyondEnd = !empty && startIndex >= lines.length

    // 第二道闸：单行截断（字符口径）
    const lineCappedLines = selectedLines.map(truncateLongLine)
    // 第三道闸：总字节封顶（字节口径，行粒度累加——不切开 UTF-8 多字节字符）
    const { acceptedLines, truncatedByBytes } = capLinesByBytes(lineCappedLines, READ_MAX_BYTES)

    const endLine = acceptedLines.length > 0 ? startIndex + acceptedLines.length : startLine
    const numberedContent = acceptedLines
      .map((line, index) => `${String(startIndex + index + 1).padStart(4, ' ')} | ${line}`)
      .join('\n')
    const truncatedByLines = startIndex + selectedLines.length < lines.length
    const notice = getReadNotice({
      empty,
      offsetBeyondEnd,
      startLine,
      endLine,
      totalLines: empty ? 0 : lines.length,
      truncated: truncatedByLines,
      truncatedByBytes,
    })

    return {
      path: input.path,
      content: acceptedLines.join('\n'),
      numberedContent,
      readFileState,
      startLine,
      endLine,
      totalLines: empty ? 0 : lines.length,
      truncated: truncatedByLines,
      truncatedByBytes,
      empty,
      offsetBeyondEnd,
      fileSizeBytes: file.size,
      notice,
    }
  },
  summarizeInput(input) {
    return input.offset || input.limit
      ? `读取 ${input.path} 的部分内容`
      : `读取 ${input.path}`
  },
  summarizeOutput(output) {
    if (output.empty) {
      return `已读取 ${output.path}，文件为空`
    }

    if (output.offsetBeyondEnd) {
      return `已读取 ${output.path}，但文件只有 ${output.totalLines} 行，短于请求的起始行 ${output.startLine}`
    }

    if (output.truncatedByBytes) {
      return `已读取 ${output.path} 第 ${output.startLine}-${output.endLine} 行（共 ${output.totalLines} 行），结果达单次上限已按字节截断`
    }

    return output.truncated
      ? `已读取 ${output.path} 第 ${output.startLine}-${output.endLine} 行，共 ${output.totalLines} 行，结果已截断`
      : `已读取 ${output.path}，共 ${output.totalLines} 行`
  },
}

/** 单行截断：超过 READ_MAX_LINE_LENGTH 字符的行截断并附标记（dsh truncateLine 同款）。 */
function truncateLongLine(line: string) {
  return line.length > READ_MAX_LINE_LENGTH
    ? `${line.slice(0, READ_MAX_LINE_LENGTH)}……（本行过长，已截断至 ${READ_MAX_LINE_LENGTH} 字符）`
    : line
}

/**
 * 字节封顶：按行累加 UTF-8 字节数，再加一行会超 maxBytes 就停止接收并标记截断。
 * 行粒度累加天然不会切开多字节字符（dsh consumeLine 同款：字节数 = 行文本字节 + 换行符）。
 */
function capLinesByBytes(lines: string[], maxBytes: number) {
  let outputBytes = 0
  const acceptedLines: string[] = []

  for (const line of lines) {
    const bytes = textEncoder.encode(line).length + (acceptedLines.length > 0 ? 1 : 0)
    if (outputBytes + bytes > maxBytes) {
      return { acceptedLines, truncatedByBytes: true }
    }
    outputBytes += bytes
    acceptedLines.push(line)
  }

  return { acceptedLines, truncatedByBytes: false }
}

function readOptionalPositiveInteger(value: unknown, label: string) {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} 必须是正整数`)
  }

  const numberValue = Number(value)

  if (numberValue > MAX_READ_LIMIT) {
    throw new Error(`${label} 不能超过 ${MAX_READ_LIMIT} 行；请分多次使用 offset/limit 读取`)
  }

  return numberValue
}

function splitLines(content: string) {
  if (!content) {
    return []
  }

  return content.replace(/\r\n/g, '\n').split('\n')
}

function getReadNotice(input: {
  empty: boolean
  offsetBeyondEnd: boolean
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  truncatedByBytes: boolean
}) {
  if (input.empty) {
    return 'Warning: 文件存在，但内容为空。'
  }

  if (input.offsetBeyondEnd) {
    return `Warning: 文件存在，但短于请求的起始行 ${input.startLine}；当前文件共 ${input.totalLines} 行。`
  }

  if (input.truncatedByBytes) {
    return `结果过大已截断（单次返回上限 ${formatBytes(READ_MAX_BYTES)} 字节）。当前显示第 ${input.startLine}-${input.endLine} 行；请用 offset=${input.endLine + 1} 继续分段读取。`
  }

  if (input.truncated) {
    return '结果已截断；如需继续阅读，请使用 offset 和 limit 读取后续行。'
  }

  return undefined
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
