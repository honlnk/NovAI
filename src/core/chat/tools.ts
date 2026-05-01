import { searchRagCandidates } from '../rag/search'
import {
  createFileTool as coreCreateFileTool,
  editFileTool as coreEditFileTool,
  readFileTool as coreReadFileTool,
} from '../tools/file-tools'

import type {
  ToolDefinition,
  ToolRuntimeContext,
} from '../../types/chat'
import type { RetrievalResult } from '../../types/rag'
import type {
  CreateFileInput,
  CreateFileOutput,
  EditFileInput,
  EditFileOutput,
  ReadFileInput,
  ReadFileOutput,
} from '../tools/types'

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

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: 'ReadFile',
  description: coreReadFileTool.description,
  validateInput: coreReadFileTool.validateInput,
  async call(input, context) {
    return coreReadFileTool.run(input, { project: context.project })
  },
  summarizeInput: coreReadFileTool.summarizeInput,
  summarizeOutput: coreReadFileTool.summarizeOutput,
}

export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  name: 'EditFile',
  description: coreEditFileTool.description,
  validateInput: coreEditFileTool.validateInput,
  async call(input, context) {
    return coreEditFileTool.run(input, { project: context.project })
  },
  summarizeInput: coreEditFileTool.summarizeInput,
  summarizeOutput: coreEditFileTool.summarizeOutput,
}

export const createFileTool: ToolDefinition<CreateFileInput, CreateFileOutput> = {
  name: 'CreateFile',
  description: coreCreateFileTool.description,
  validateInput: coreCreateFileTool.validateInput,
  async call(input, context) {
    return coreCreateFileTool.run(input, { project: context.project })
  },
  summarizeInput: coreCreateFileTool.summarizeInput,
  summarizeOutput: coreCreateFileTool.summarizeOutput,
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

export function createToolRuntimeContext(context: ToolRuntimeContext): ToolRuntimeContext {
  return context
}
