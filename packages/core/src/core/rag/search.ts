import { createEmbedding } from '../embedding/client'

import type { ProjectConfig } from '../../types/project'
import type { RetrievalQuery, RetrievalResult } from '../../types/rag'

import { searchOrama } from './orama-index'

export async function searchRagCandidates(
  query: RetrievalQuery,
  config: ProjectConfig,
): Promise<RetrievalResult> {
  const queryEmbedding = await createEmbedding({
    baseUrl: config.embedding.baseUrl,
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    text: query.query,
  })

  // 粗召回完全交给 Orama 内存索引（向量相似度 + metadata 过滤），
  // 不再做本地 cosine 全量遍历。详见 orama-index.ts。
  return searchOrama(query.projectId, query, queryEmbedding.vector)
}
