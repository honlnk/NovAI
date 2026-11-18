/**
 * 看板卡片同列排序原语（计划/伏笔/节奏卡共用，业务无关，泛型于状态字段）。
 */

/**
 * 同列排序：order 升序；order 相同再按 createdAt、id 排序，保证结果确定。
 */
export function sortBoardCards<T extends { order: number; createdAt: string; id: string }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }

    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 目标列末尾的新 order 值：比该列当前最大 order 大一个步长。 */
export function nextOrderInColumn<T extends { status: string; order: number }>(
  cards: readonly T[],
  status: T['status'],
  step = 100,
): number {
  const max = cards
    .filter((card) => card.status === status)
    .reduce((current, card) => Math.max(current, card.order), Number.NEGATIVE_INFINITY)

  return max === Number.NEGATIVE_INFINITY ? 0 : max + step
}

/** 拖到同列某卡片之后应取的 order 值：取相邻两卡 order 的中点；无右侧邻居时 + 步长。 */
export function orderAfter<T extends { id: string; status: string; order: number; createdAt: string }>(
  cards: readonly T[],
  status: T['status'],
  afterId: string | null,
  step = 100,
): number {
  const column = sortBoardCards(cards.filter((card) => card.status === status))

  if (afterId === null) {
    return column.length === 0 ? 0 : (column[column.length - 1]?.order ?? 0) + step
  }

  const index = column.findIndex((card) => card.id === afterId)
  const target = column[index]

  if (!target) {
    return nextOrderInColumn(column, status, step)
  }

  const next = column[index + 1]

  if (!next) {
    return target.order + step
  }

  return (target.order + next.order) / 2
}

/**
 * 拖到同列某卡片之前应取的 order 值：取相邻两卡 order 的中点；无左侧邻居时
 * - 步长（order 允许为负，排序仍稳定）。beforeId=null 表示插到列首（空列取 0）。
 */
export function orderBefore<T extends { id: string; status: string; order: number; createdAt: string }>(
  cards: readonly T[],
  status: T['status'],
  beforeId: string | null,
  step = 100,
): number {
  const column = sortBoardCards(cards.filter((card) => card.status === status))

  const index = beforeId === null ? 0 : column.findIndex((card) => card.id === beforeId)
  const target = column[index]

  if (!target) {
    // 空列取 0；锚点不在目标列按列末尾处理（与 orderAfter 同口径）
    return nextOrderInColumn(column, status, step)
  }

  const previous = column[index - 1]

  if (!previous) {
    return target.order - step
  }

  return (previous.order + target.order) / 2
}
