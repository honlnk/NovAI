import {
  getProjectTextFile,
  readProjectTextFile,
  writeProjectTextFile,
} from '../fs/project-fs'

import { assertTextFilePath, isNotFoundError, normalizeProjectPath } from './path'
import type {
  CreateFileInput,
  CreateFileOutput,
  EditFileInput,
  EditFileOutput,
  ReadFileInput,
  ReadFileOutput,
  ToolDefinition,
} from './types'

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

export const editFileTool: ToolDefinition<'EditFile', EditFileInput, EditFileOutput> = {
  name: 'EditFile',
  description: '用精确文本替换的方式修改当前小说项目中的已有文本文件。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'EditFile.path'))
    const oldText = readString(value.oldText, 'EditFile.oldText')
    const newText = readString(value.newText, 'EditFile.newText')

    assertTextFilePath(path)

    if (oldText === newText) {
      throw new Error('EditFile.oldText 和 EditFile.newText 完全相同，没有可修改内容')
    }

    return {
      path,
      oldText,
      newText,
      replaceAll: typeof value.replaceAll === 'boolean' ? value.replaceAll : false,
    }
  },
  async run(input, runtime) {
    const currentContent = await readProjectTextFile(runtime.project.handle, input.path)

    if (!input.oldText) {
      if (currentContent.length > 0) {
        throw new Error('EditFile.oldText 不能为空；新增文件请使用 CreateFile，覆盖非空文件请提供原文')
      }

      await writeProjectTextFile(runtime.project.handle, input.path, input.newText)

      return {
        path: input.path,
        occurrences: 1,
        contentLength: input.newText.length,
        linesAdded: countLines(input.newText),
        linesRemoved: 0,
      }
    }

    const occurrences = countOccurrences(currentContent, input.oldText)

    if (occurrences === 0) {
      throw new Error(`在 ${input.path} 中没有找到要替换的原文`)
    }

    if (occurrences > 1 && !input.replaceAll) {
      throw new Error(`在 ${input.path} 中找到 ${occurrences} 处匹配；请提供更精确的 oldText，或启用 replaceAll`)
    }

    const nextContent = input.replaceAll
      ? currentContent.split(input.oldText).join(input.newText)
      : currentContent.replace(input.oldText, input.newText)

    await writeProjectTextFile(runtime.project.handle, input.path, nextContent)

    return {
      path: input.path,
      occurrences: input.replaceAll ? occurrences : 1,
      contentLength: nextContent.length,
      linesAdded: countLines(input.newText) - countLines(input.oldText),
      linesRemoved: Math.max(countLines(input.oldText) - countLines(input.newText), 0),
    }
  },
  summarizeInput(input) {
    return input.replaceAll
      ? `替换 ${input.path} 中所有匹配文本`
      : `替换 ${input.path} 中一处匹配文本`
  },
  summarizeOutput(output) {
    return `已修改 ${output.path}，替换 ${output.occurrences} 处，当前 ${output.contentLength} 个字符`
  },
}

export const createFileTool: ToolDefinition<'CreateFile', CreateFileInput, CreateFileOutput> = {
  name: 'CreateFile',
  description: '在当前小说项目中新建文本文件；如果目标已存在会失败。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'CreateFile.path'))
    const content = readString(value.content, 'CreateFile.content')

    assertTextFilePath(path)

    return {
      path,
      content,
    }
  },
  async run(input, runtime) {
    try {
      await readProjectTextFile(runtime.project.handle, input.path)
      throw new Error(`文件已存在：${input.path}`)
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }
    }

    await writeProjectTextFile(runtime.project.handle, input.path, input.content)

    return {
      path: input.path,
      contentLength: input.content.length,
      created: true,
    }
  },
  summarizeInput(input) {
    return `新建 ${input.path}`
  },
  summarizeOutput(output) {
    return `已新建 ${output.path}，共 ${output.contentLength} 个字符`
  },
}

function asRecord(input: unknown) {
  if (!input || typeof input !== 'object') {
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

function countOccurrences(source: string, needle: string) {
  if (!needle) {
    return 0
  }

  return source.split(needle).length - 1
}

function countLines(content: string) {
  if (!content) {
    return 0
  }

  return content.replace(/\r\n/g, '\n').split('\n').length
}
