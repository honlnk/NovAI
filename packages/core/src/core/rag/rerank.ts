import { rerankCandidates, type RerankConnectionInput } from '../ai/rerank-client'

import type { ProjectConfig } from '../../types/project'
import type { RetrievalCandidate, RerankResult } from '../../types/rag'

export async function rerankRetrievalCandidates(
  config: ProjectConfig,
  query: string,
  candidates: RetrievalCandidate[],
): Promise<RetrievalCandidate[]> {
  if (!config.rerank.enabled || candidates.length === 0) {
    return candidates.slice(0, config.rerank.topN)
  }

  try {
    const result = await rerankWithConfig(
      {
        baseUrl: config.rerank.baseUrl,
        apiKey: config.rerank.apiKey,
        model: config.rerank.model,
      },
      query,
      candidates,
      config.rerank.topN,
    )

    const scoreMap = new Map(result.items.map((item) => [item.id, item.score]))

    return candidates
      .filter((candidate) => scoreMap.has(candidate.id))
      .map((candidate) => ({
        ...candidate,
        rerankScore: scoreMap.get(candidate.id),
      }))
      .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0))
  } catch {
    // 浏览器直连某些 Rerank 服务时可能被 CORS 拦截；这里自动降级为仅使用粗召回结果。
    return candidates.slice(0, config.rerank.topN)
  }
}

export async function rerankWithConfig(
  connection: RerankConnectionInput,
  query: string,
  candidates: RetrievalCandidate[],
  topN: number,
): Promise<RerankResult> {
  return rerankCandidates({
    ...connection,
    query,
    topN,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      name: candidate.name,
      summary: candidate.summary,
      retrievalText: candidate.retrievalText,
      lastUpdatedChapter: candidate.lastUpdatedChapter,
      relatedChapters: candidate.relatedChapters,
    })),
  })
}
