import { buildGenerationContextDraft, selectFinalContextItems } from '../core/rag/context'
import { explainRetrievalCandidates } from '../core/rag/explain'
import { buildProjectIndex, getProjectIndexMeta } from '../core/rag/indexer'
import { rerankRetrievalCandidates } from '../core/rag/rerank'
import { searchRagCandidates } from '../core/rag/search'

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

export async function rebuildIndex(projectId: string): Promise<IndexBuildResultView> {
  const project = requireRuntimeProject(projectId)

  return buildProjectIndex(project, {
    projectId,
    reason: 'manual-rebuild',
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
