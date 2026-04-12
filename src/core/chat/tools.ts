import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'
import { searchRagCandidates } from '../rag/search'

import type {
  ToolDefinition,
  ToolRuntimeContext,
} from '../../types/chat'
import type { RetrievalResult } from '../../types/rag'

export type FileReadInput = {
  path: string
}

export type FileReadOutput = {
  path: string
  content: string
}

export type FileWriteInput = {
  path: string
  content: string
}

export type FileWriteOutput = {
  path: string
  contentLength: number
  created: boolean
}

export type FileEditInput = {
  path: string
  content: string
}

export type FileEditOutput = {
  path: string
  contentLength: number
}

export type RagSearchInput = {
  query: string
  topK?: number
}

function asObject(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}

export const fileReadTool: ToolDefinition<FileReadInput, FileReadOutput> = {
  name: 'FileRead',
  description: '读取项目中的文本文件',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.path !== 'string' || !value.path.trim()) {
      throw new Error('FileRead 需要有效的 path')
    }

    return {
      path: value.path.trim(),
    }
  },
  async call(input, context) {
    const content = await readProjectTextFile(context.project.handle, input.path)

    return {
      path: input.path,
      content,
    }
  },
  summarizeInput(input) {
    return `读取 ${input.path}`
  },
  summarizeOutput(output) {
    return `已读取 ${output.path}，共 ${output.content.length} 个字符`
  },
}

export const fileWriteTool: ToolDefinition<FileWriteInput, FileWriteOutput> = {
  name: 'FileWrite',
  description: '写入项目中的文本文件',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.path !== 'string' || !value.path.trim()) {
      throw new Error('FileWrite 需要有效的 path')
    }

    if (typeof value.content !== 'string') {
      throw new Error('FileWrite 需要字符串 content')
    }

    return {
      path: value.path.trim(),
      content: value.content,
    }
  },
  async call(input, context) {
    await writeProjectTextFile(context.project.handle, input.path, input.content)

    return {
      path: input.path,
      contentLength: input.content.length,
      created: true,
    }
  },
  summarizeInput(input) {
    return `写入 ${input.path}`
  },
  summarizeOutput(output) {
    return `已写入 ${output.path}，共 ${output.contentLength} 个字符`
  },
}

export const fileEditTool: ToolDefinition<FileEditInput, FileEditOutput> = {
  name: 'FileEdit',
  description: '覆盖修改已有文本文件',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.path !== 'string' || !value.path.trim()) {
      throw new Error('FileEdit 需要有效的 path')
    }

    if (typeof value.content !== 'string') {
      throw new Error('FileEdit 需要字符串 content')
    }

    return {
      path: value.path.trim(),
      content: value.content,
    }
  },
  async call(input, context) {
    await writeProjectTextFile(context.project.handle, input.path, input.content)

    return {
      path: input.path,
      contentLength: input.content.length,
    }
  },
  summarizeInput(input) {
    return `修改 ${input.path}`
  },
  summarizeOutput(output) {
    return `已更新 ${output.path}，共 ${output.contentLength} 个字符`
  },
}

export const ragSearchTool: ToolDefinition<RagSearchInput, RetrievalResult> = {
  name: 'RagSearch',
  description: '基于项目要素索引做语义检索',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.query !== 'string' || !value.query.trim()) {
      throw new Error('RagSearch 需要有效的 query')
    }

    return {
      query: value.query.trim(),
      topK: typeof value.topK === 'number' ? value.topK : undefined,
    }
  },
  async call(input, context) {
    return searchRagCandidates({
      projectId: context.project.id,
      query: input.query,
      topK: input.topK ?? context.config.settings.ragCandidateLimit,
    }, context.config)
  },
  summarizeInput(input) {
    return `检索与“${input.query}”相关的故事要素`
  },
  summarizeOutput(output) {
    return output.total > 0
      ? `共召回 ${output.total} 条候选`
      : '索引中暂无可召回候选'
  },
}

export const bashTool: ToolDefinition<{ command: string }, { output: string }> = {
  name: 'Bash',
  description: '第一阶段保留占位，后续再接真实命令执行',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.command !== 'string' || !value.command.trim()) {
      throw new Error('Bash 需要有效的 command')
    }

    return {
      command: value.command.trim(),
    }
  },
  async call() {
    throw new Error('第一阶段 Session Lab 还未接入真实 Bash 工具')
  },
  summarizeInput(input) {
    return `执行命令：${input.command}`
  },
  summarizeOutput(output) {
    return output.output
  },
}

export function createToolRuntimeContext(context: ToolRuntimeContext): ToolRuntimeContext {
  return context
}
