import type { GenerationContextDraft, RetrievalCandidate } from '../../types/rag'

export function buildGenerationContextDraft(input: {
  query: string
  recentChapters?: GenerationContextDraft['recentChapters']
  retrievedCandidates?: RetrievalCandidate[]
  rerankedCandidates?: RetrievalCandidate[]
  finalContextItems?: RetrievalCandidate[]
}): GenerationContextDraft {
  return {
    query: input.query,
    recentChapters: input.recentChapters ?? [],
    retrievedCandidates: input.retrievedCandidates ?? [],
    rerankedCandidates: input.rerankedCandidates ?? [],
    finalContextItems: input.finalContextItems ?? [],
  }
}

export function selectFinalContextItems(
  candidates: RetrievalCandidate[],
  limit: number,
): RetrievalCandidate[] {
  return candidates.slice(0, limit)
}
