import type { RetrievalCandidate } from '../../types/rag'

export function selectFinalContextItems(
  candidates: RetrievalCandidate[],
  limit: number,
): RetrievalCandidate[] {
  return candidates.slice(0, limit)
}
