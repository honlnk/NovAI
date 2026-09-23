import { resolveSearchProvider } from '../web/search-provider'
import type {
  ToolDefinition,
  WebSearchInput,
  WebSearchOutput,
} from './types'

/** 多 query 合并后的来源上限（决策 8：不暴露给模型的部署配置） */
const MAX_SOURCES = 8
const MAX_QUERIES = 4

export const webSearchTool: ToolDefinition<'WebSearch', WebSearchInput, WebSearchOutput> = {
  name: 'WebSearch',
  description: '联网搜索外部信息（新闻、资料、事实核查等）。一次可给 1-4 个不同角度的 query，结果去重合并后返回带来源 URL 的摘要列表。',
  validateInput(input) {
    const value = asObject(input)

    if (!Array.isArray(value.queries) || value.queries.length === 0) {
      throw new Error('WebSearch 需要非空的 queries 数组（1-4 条）')
    }

    const queries = value.queries.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('queries 只能包含非空字符串')
      }
      return item.trim()
    })

    if (queries.length > MAX_QUERIES) {
      throw new Error(`queries 最多 ${MAX_QUERIES} 条（收到 ${queries.length} 条）`)
    }

    return { queries }
  },
  async run(input, runtime) {
    const provider = resolveSearchProvider({
      ...runtime.project.config.search,
      webClientId: runtime.webClientId,
    })

    // 多 query 并发（任一失败则整体失败——决策 8：失败不重试，错误直接抛给模型）
    const outcomes = await Promise.all(input.queries.map((query) => provider.search(query)))

    const merged = mergeSearchResults(outcomes)

    return {
      queries: input.queries,
      content: outcomes.map((outcome) => outcome.content).find((text) => text?.trim()) ?? undefined,
      sources: merged.sources,
      truncated: merged.truncated,
    }
  },
  summarizeInput(input) {
    return `联网搜索：${input.queries.join('；')}`
  },
  summarizeOutput(output) {
    const label = output.queries.length > 1 ? `${output.queries.length} 组查询` : '查询'
    if (output.sources.length === 0) {
      return `WebSearch ${label}无结果`
    }
    return `WebSearch ${label}返回 ${output.sources.length} 条来源${output.truncated ? '（已截断）' : ''}`
  },
}

/**
 * 多 query 结果合并（照 dsh mergeSearchResults 语义）：
 * 按排名 round-robin 交错（每个 query 的头部结果都有机会靠前）+ URL 去重 + cap MAX_SOURCES。
 */
export function mergeSearchResults(
  outcomes: Array<{ sources: Array<{ title: string; url: string; snippet: string; publishedAt?: string }> }>,
): { sources: WebSearchOutput['sources']; truncated: boolean } {
  const seen = new Set<string>()
  const merged: WebSearchOutput['sources'] = []

  for (let rank = 0; merged.length < MAX_SOURCES; rank++) {
    let appended = false
    for (const outcome of outcomes) {
      const source = outcome.sources[rank]
      if (!source) continue
      const canonical = source.url.replace(/#.*$/, '')
      if (seen.has(canonical)) continue
      seen.add(canonical)
      merged.push(source)
      appended = true
      if (merged.length >= MAX_SOURCES) break
    }
    // 所有 query 都取尽（rank 超过每个列表长度）则结束
    if (!appended && outcomes.every((outcome) => rank >= outcome.sources.length)) {
      break
    }
  }

  // 截断标志：合并去重后总量超过上限才算截断
  const total = outcomes.reduce((sum, outcome) => sum + outcome.sources.length, 0)
  const uniqueTotal = new Set(outcomes.flatMap((outcome) => outcome.sources.map((s) => s.url.replace(/#.*$/, '')))).size

  return { sources: merged, truncated: uniqueTotal > MAX_SOURCES && total > MAX_SOURCES }
}

function asObject(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}
