export type ElementType = 'character' | 'location' | 'timeline' | 'plot' | 'worldbuilding'

export type IndexStatus = 'empty' | 'building' | 'ready' | 'stale' | 'rebuilding' | 'error'

export type IndexedElementDocument = {
  id: string
  projectId: string
  sourcePath: string
  type: ElementType
  name: string
  summary: string
  retrievalText: string
  vector: number[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  tags: string[]
  sourceModifiedAt: string
  indexedAt: string
  contentHash: string
  embeddingProvider: string
  embeddingModel: string
  embeddingDim: number
  embeddingTextVersion: number
}

export type ProjectIndexMeta = {
  projectId: string
  status: IndexStatus
  documentCount: number
  embeddingProvider: string
  embeddingModel: string
  embeddingDim: number
  embeddingTextVersion: number
  rerankProvider?: string
  rerankModel?: string
  lastBuildAt?: string
  lastFullRebuildAt?: string
  lastError?: string
}

export type RetrievalCandidate = {
  id: string
  projectId: string
  sourcePath: string
  type: ElementType
  name: string
  summary: string
  retrievalText: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  score?: number
  rerankScore?: number
}

export type RetrievalQuery = {
  projectId: string
  query: string
  topK: number
  filters?: {
    type?: ElementType[]
    tags?: string[]
    lastUpdatedChapter?: string
  }
}

export type RetrievalResult = {
  query: string
  candidates: RetrievalCandidate[]
  total: number
}

export type RerankInput = {
  query: string
  candidates: Array<{
    id: string
    type: string
    name: string
    summary: string
    retrievalText: string
    lastUpdatedChapter: string
    relatedChapters: string[]
  }>
  topN: number
}

export type RerankResultItem = {
  id: string
  score: number
}

export type RerankResult = {
  items: RerankResultItem[]
  model?: string
}

export type GenerationContextDraft = {
  query: string
  recentChapters: Array<{
    path: string
    title: string
    content: string
  }>
  retrievedCandidates: RetrievalCandidate[]
  rerankedCandidates: RetrievalCandidate[]
  finalContextItems: RetrievalCandidate[]
}

export type IndexBuildReason =
  | 'initial-build'
  | 'incremental-update'
  | 'full-rebuild'
  | 'model-changed'
  | 'template-upgraded'
  | 'manual-rebuild'

export type IndexBuildRequest = {
  projectId: string
  reason: IndexBuildReason
  sourcePaths?: string[]
}

export type IndexBuildResult = {
  projectId: string
  status: IndexStatus
  indexedCount: number
  skippedCount: number
  failedCount: number
  message: string
}

export type RetrievalExplanation = {
  id: string
  name: string
  type: ElementType
  summary: string
  sourcePath: string
  selectedBy: 'recall' | 'rerank' | 'final-context'
  reason: string
  lastUpdatedChapter: string
}
