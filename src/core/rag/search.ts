import { createEmbedding } from '../embedding/client'

import type { ProjectConfig } from '../../types/project'
import type { RetrievalCandidate, RetrievalQuery, RetrievalResult } from '../../types/rag'

import { createRagIndexStore } from './index-store'

export async function searchRagCandidates(
  query: RetrievalQuery,
  config: ProjectConfig,
): Promise<RetrievalResult> {
  const store = createRagIndexStore()
  const documents = await store.listProjectDocuments(query.projectId)

  if (documents.length === 0) {
    return {
      query: query.query,
      candidates: [],
      total: 0,
    }
  }

  const queryEmbedding = await createEmbedding({
    baseUrl: config.embedding.baseUrl,
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    text: query.query,
  })

  const candidates: RetrievalCandidate[] = documents
    .filter((document) => matchesFilters(document, query))
    .map((document) => ({
      id: document.id,
      projectId: document.projectId,
      sourcePath: document.sourcePath,
      type: document.type,
      name: document.name,
      summary: document.summary,
      retrievalText: document.retrievalText,
      tags: document.tags,
      lastUpdatedChapter: document.lastUpdatedChapter,
      relatedChapters: document.relatedChapters,
      score: cosineSimilarity(queryEmbedding.vector, document.vector),
    }))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, query.topK)

  return {
    query: query.query,
    candidates,
    total: candidates.length,
  }
}

function matchesFilters(
  document: { type: RetrievalCandidate['type']; tags: string[]; lastUpdatedChapter: string },
  query: RetrievalQuery,
) {
  if (query.filters?.type?.length && !query.filters.type.includes(document.type)) {
    return false
  }

  if (query.filters?.tags?.length && !query.filters.tags.some((tag) => document.tags.includes(tag))) {
    return false
  }

  if (query.filters?.lastUpdatedChapter && query.filters.lastUpdatedChapter !== document.lastUpdatedChapter) {
    return false
  }

  return true
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}
