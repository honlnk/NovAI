import { selectFinalContextItems } from '../rag/context'
import { rerankRetrievalCandidates } from '../rag/rerank'
import { searchRagCandidates } from '../rag/search'
import type {
  RagSearchInput,
  RagSearchOutput,
  ToolDefinition,
} from './types'
import type { ElementType } from '../../types/rag'

const ELEMENT_TYPES: ElementType[] = ['character', 'location', 'entity', 'timeline', 'plot', 'worldbuilding']

export const ragSearchTool: ToolDefinition<'RagSearch', RagSearchInput, RagSearchOutput> = {
  name: 'RagSearch',
  description: '基于当前项目的要素向量索引做语义检索，可用于写作前召回人物、地点、剧情、时间线和世界观设定。',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.query !== 'string' || !value.query.trim()) {
      throw new Error('RagSearch 需要有效的 query')
    }

    return {
      query: value.query.trim(),
      topK: readPositiveInteger(value.topK, 'topK'),
      finalLimit: readPositiveInteger(value.finalLimit, 'finalLimit'),
      filters: readFilters(value.filters),
    }
  },
  async run(input, runtime) {
    const config = runtime.project.config
    const retrieval = await searchRagCandidates({
      projectId: runtime.project.id,
      query: input.query,
      topK: input.topK ?? config.settings.ragCandidateLimit,
      filters: input.filters,
    }, config)
    const reranked = await rerankRetrievalCandidates(config, input.query, retrieval.candidates)
    const finalItems = selectFinalContextItems(
      reranked,
      input.finalLimit ?? config.settings.ragContextMaxItems,
    )

    return {
      query: input.query,
      recalledCount: retrieval.candidates.length,
      returnedCount: finalItems.length,
      usedRerank: config.rerank.enabled && retrieval.candidates.length > 0,
      candidates: finalItems.map((candidate) => ({
        id: candidate.id,
        sourcePath: candidate.sourcePath,
        type: candidate.type,
        name: candidate.name,
        summary: candidate.summary,
        retrievalText: candidate.retrievalText,
        tags: candidate.tags,
        lastUpdatedChapter: candidate.lastUpdatedChapter,
        relatedChapters: candidate.relatedChapters,
        score: candidate.score,
        rerankScore: candidate.rerankScore,
      })),
    }
  },
  summarizeInput(input) {
    return `RAG 检索：${input.query}`
  },
  summarizeOutput(output) {
    if (output.returnedCount === 0) {
      return 'RAG 未召回可用上下文'
    }

    const method = output.usedRerank ? '召回并重排' : '召回'
    return `RAG ${method} ${output.recalledCount} 条，返回 ${output.returnedCount} 条上下文`
  },
}

function asObject(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}

function readPositiveInteger(value: unknown, field: string) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数`)
  }

  return value
}

function readFilters(value: unknown): RagSearchInput['filters'] {
  if (value === undefined) {
    return undefined
  }

  const filters = asObject(value)
  const result: NonNullable<RagSearchInput['filters']> = {}

  if (filters.type !== undefined) {
    if (!Array.isArray(filters.type)) {
      throw new Error('filters.type 必须是数组')
    }

    result.type = filters.type.map((item) => {
      if (typeof item !== 'string' || !ELEMENT_TYPES.includes(item as ElementType)) {
        throw new Error(`未知要素类型：${String(item)}`)
      }

      return item as ElementType
    })
  }

  if (filters.tags !== undefined) {
    if (!Array.isArray(filters.tags)) {
      throw new Error('filters.tags 必须是数组')
    }

    result.tags = filters.tags.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('filters.tags 只能包含非空字符串')
      }

      return item.trim()
    })
  }

  if (filters.lastUpdatedChapter !== undefined) {
    if (typeof filters.lastUpdatedChapter !== 'string') {
      throw new Error('filters.lastUpdatedChapter 必须是字符串')
    }

    result.lastUpdatedChapter = filters.lastUpdatedChapter.trim()
  }

  return result
}
