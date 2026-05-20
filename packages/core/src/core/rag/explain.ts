import type { RetrievalCandidate, RetrievalExplanation } from '../../types/rag'

export function explainRetrievalCandidates(
  candidates: RetrievalCandidate[],
  selectedBy: RetrievalExplanation['selectedBy'],
): RetrievalExplanation[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    summary: candidate.summary,
    sourcePath: candidate.sourcePath,
    selectedBy,
    reason: buildReason(candidate, selectedBy),
    lastUpdatedChapter: candidate.lastUpdatedChapter,
  }))
}

function buildReason(
  candidate: RetrievalCandidate,
  selectedBy: RetrievalExplanation['selectedBy'],
) {
  if (selectedBy === 'final-context') {
    return `已进入最终生成上下文，来源于 ${candidate.type} 要素检索`
  }

  if (selectedBy === 'rerank') {
    return `已进入重排结果，候选摘要为：${candidate.summary || candidate.name}`
  }

  return `已被粗召回命中，候选摘要为：${candidate.summary || candidate.name}`
}
