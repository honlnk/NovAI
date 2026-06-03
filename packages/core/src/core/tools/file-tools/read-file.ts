import { getProjectTextFile } from '../../fs/project-fs'
import type { ReadFileInput, ReadFileOutput, ToolDefinition } from '../types'
import { asRecord, readString } from './common'
import { createReadFileState } from './read-file-state'
import { assertTextFilePath, normalizeProjectPath } from '../path'

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_LIMIT = 2000
const MAX_FULL_READ_BYTES = 512 * 1024

export const readFileTool: ToolDefinition<'ReadFile', ReadFileInput, ReadFileOutput> = {
  name: 'ReadFile',
  description: '读取当前小说项目中的文本文件，返回带行号的内容。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'ReadFile.path'))
    assertTextFilePath(path)

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
    const endLine = selectedLines.length > 0 ? startIndex + selectedLines.length : startLine
    const numberedContent = selectedLines
      .map((line, index) => `${String(startIndex + index + 1).padStart(4, ' ')} | ${line}`)
      .join('\n')
    const notice = getReadNotice({
      empty,
      offsetBeyondEnd,
      startLine,
      totalLines: empty ? 0 : lines.length,
      truncated: startIndex + selectedLines.length < lines.length,
    })

    return {
      path: input.path,
      content: selectedLines.join('\n'),
      numberedContent,
      readFileState,
      startLine,
      endLine,
      totalLines: empty ? 0 : lines.length,
      truncated: startIndex + selectedLines.length < lines.length,
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

    return output.truncated
      ? `已读取 ${output.path} 第 ${output.startLine}-${output.endLine} 行，共 ${output.totalLines} 行，结果已截断`
      : `已读取 ${output.path}，共 ${output.totalLines} 行`
  },
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
  totalLines: number
  truncated: boolean
}) {
  if (input.empty) {
    return 'Warning: 文件存在，但内容为空。'
  }

  if (input.offsetBeyondEnd) {
    return `Warning: 文件存在，但短于请求的起始行 ${input.startLine}；当前文件共 ${input.totalLines} 行。`
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
