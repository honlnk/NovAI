import { buildGenerationContextDraft, selectFinalContextItems } from '../core/rag/context'
import { explainRetrievalCandidates } from '../core/rag/explain'
import { buildProjectIndex, getProjectIndexMeta } from '../core/rag/indexer'
import { onRagIndexChange } from '../core/rag/index-events'
import { rerankRetrievalCandidates } from '../core/rag/rerank'
import { searchRagCandidates } from '../core/rag/search'

import type { ProjectIndexMeta } from '../types/rag'
import { requireRuntimeProject } from './project-runtime'
import type {
  GenerationContextDraftView,
  IndexBuildResultView,
  ProjectIndexMetaView,
  RetrievalExplanationView,
} from './types'

export async function inspectIndex(projectId: string): Promise<ProjectIndexMetaView | null> {
  requireRuntimeProject(projectId)
  return getProjectIndexMeta(projectId)
}

/**
 * 订阅某个项目的索引状态变化（要素写入标 stale / 重建完成 / 构建失败等）。
 * 返回取消订阅函数。事件总线封装在 core 层，app 层通过本函数统一访问。
 */
export function subscribeIndexChange(
  projectId: string,
  callback: (meta: ProjectIndexMetaView) => void,
): () => void {
  // core 层事件用的是内部 ProjectIndexMeta，结构与 view 等价，直接透传。
  const wrapped = (meta: ProjectIndexMeta) => callback(meta)
  return onRagIndexChange(projectId, wrapped)
}

/**
 * 重建索引。
 *
 * 不传 sourcePaths 时为全量重建（manual-rebuild，会 clearProject）；
 * 传 sourcePaths 时为增量重建（incremental-update，不清空，且 buildProjectIndex
 * 内部会用 contentHash 短路复用未变文档的向量，只对变更文件调 Embedding）。
 */
export async function rebuildIndex(
  projectId: string,
  sourcePaths?: string[],
): Promise<IndexBuildResultView> {
  const project = requireRuntimeProject(projectId)

  return buildProjectIndex(project, {
    projectId,
    reason: sourcePaths && sourcePaths.length > 0 ? 'incremental-update' : 'manual-rebuild',
    sourcePaths,
  })
}

export async function runRagDebug(projectId: string, query: string): Promise<{
  draft: GenerationContextDraftView
  explanations: RetrievalExplanationView[]
  recalledCount: number
}> {
  const project = requireRuntimeProject(projectId)
  const config = project.config
  const retrieval = await searchRagCandidates({
    projectId,
    query,
    topK: config.settings.ragCandidateLimit,
  }, config)
  const reranked = await rerankRetrievalCandidates(config, query, retrieval.candidates)
  const finalItems = selectFinalContextItems(reranked, config.settings.ragContextMaxItems)

  return {
    draft: buildGenerationContextDraft({
      query,
      retrievedCandidates: retrieval.candidates,
      rerankedCandidates: reranked,
      finalContextItems: finalItems,
    }),
    explanations: [
      ...explainRetrievalCandidates(retrieval.candidates, 'recall'),
      ...explainRetrievalCandidates(reranked, 'rerank'),
      ...explainRetrievalCandidates(finalItems, 'final-context'),
    ],
    recalledCount: retrieval.candidates.length,
  }
}
