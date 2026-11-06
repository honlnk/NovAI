import type { PlanBoardView, PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'

/**
 * 看板本地重排（加载反馈修复 §拖动即时反馈）：拖拽/状态切换松手后先把卡片
 * 移到目标位置再等写盘与目录重扫，期间看板不清空、不回跳；失败路径由调用方
 * 重新拉取真实看板覆盖。纯函数便于单测，不修改入参。
 */
export function moveCardInBoard(
  board: PlanBoardView,
  id: string,
  status: PlanStatusView,
  afterId: string | null,
): PlanBoardView {
  if (id === afterId) {
    return board
  }

  const entries = Object.entries(board.columns) as [PlanStatusView, PlanCardSummaryView[]][]
  const source = entries.find(([, cards]) => cards.some((card) => card.id === id))
  if (!source) {
    return board
  }

  const [sourceStatus, sourceCards] = source
  const card = sourceCards.find((item) => item.id === id)
  if (!card) {
    return board
  }

  const columns: Record<PlanStatusView, PlanCardSummaryView[]> = {
    inbox: [...board.columns.inbox],
    planned: [...board.columns.planned],
    'in-progress': [...board.columns['in-progress']],
    done: [...board.columns.done],
    'on-hold': [...board.columns['on-hold']],
  }
  columns[sourceStatus] = sourceCards.filter((item) => item.id !== id)

  const targetCards = columns[status]
  if (afterId === null) {
    targetCards.push({ ...card, status })
  } else {
    const anchorIndex = targetCards.findIndex((item) => item.id === afterId)
    if (anchorIndex === -1) {
      // 锚点不在目标列（看板与请求瞬间不一致）：不动本地视图，等服务端结果
      return board
    }
    targetCards.splice(anchorIndex + 1, 0, { ...card, status })
  }
  columns[status] = targetCards

  return { ...board, columns }
}
