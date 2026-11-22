/**
 * 看板本地重排的通用纯函数（创作心智模块施工计划 §10.5，自计划模块上提泛化）：
 * 拖拽/状态切换松手后先把卡片移到目标位置再等写盘与目录重扫，期间看板不清空、
 * 不回跳；失败路径由调用方重新拉取真实看板覆盖。纯函数便于单测，不修改入参。
 *
 * 状态枚举与列集合由调用方的看板类型注入（计划五列、伏笔六状态、节奏三列），
 * 这里只约定「columns: 状态 → 有序卡片数组」这一结构。
 */

/** 各列有序卡片的看板结构约定（issues 等其余字段由具体看板类型自带）；列数组只读 */
export type BoardColumns<TStatus extends string, TCard> = Record<TStatus, readonly TCard[]>

export function moveCardInBoard<
  TStatus extends string,
  TCard extends { id: string; status: TStatus },
  TBoard extends { columns: BoardColumns<TStatus, TCard> },
>(
  board: TBoard,
  id: string,
  /** 目标列；NoInfer 让 TStatus 只从看板类型推断，字面量状态不收窄列集合 */
  status: NoInfer<TStatus>,
  afterId: string | null,
  /** 插到某卡片之前；提供时优先于 afterId（null = 列首）。看板拖拽的列首落点用 */
  beforeId?: string | null,
): TBoard {
  if (id === afterId || id === beforeId) {
    return board
  }

  const entries = Object.entries(board.columns) as [TStatus, TCard[]][]
  const source = entries.find(([, cards]) => cards.some((card) => card.id === id))
  if (!source) {
    return board
  }

  const [sourceStatus, sourceCards] = source
  const card = sourceCards.find((item) => item.id === id)
  if (!card) {
    return board
  }

  const columns = Object.fromEntries(
    entries.map(([key, cards]) => [key, [...cards]]),
  ) as unknown as BoardColumns<TStatus, TCard>
  columns[sourceStatus] = sourceCards.filter((item) => item.id !== id)

  const targetCards = [...columns[status]]
  if (beforeId !== undefined) {
    if (beforeId === null) {
      targetCards.unshift({ ...card, status })
    } else {
      const anchorIndex = targetCards.findIndex((item) => item.id === beforeId)
      if (anchorIndex === -1) {
        // 锚点不在目标列（看板与请求瞬间不一致）：不动本地视图，等服务端结果
        return board
      }
      targetCards.splice(anchorIndex, 0, { ...card, status })
    }
  } else if (afterId === null) {
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

/* ---------- 拖拽落点（纯函数：中心线判定与插入位置 → 移动参数） ---------- */

/**
 * 以卡片垂直中心线为界算插入序号：指针在某卡中心上方 → 插它之前；中心及下方
 * → 越过它。rects 为目标列中排除被拖卡片后的真实卡片几何（自上而下）。
 */
export function boardDropInsertionIndex(
  rects: readonly { top: number; height: number }[],
  pointerY: number,
): number {
  let index = 0
  for (const rect of rects) {
    if (pointerY < rect.top + rect.height / 2) {
      break
    }
    index += 1
  }
  return index
}

/** 插入序号 → 移动参数：列首用 beforeId（空列/列尾用 afterId=null）。 */
export function boardMovePositionForInsertion<TCard extends { id: string }>(
  cards: readonly TCard[],
  dragId: string,
  insertionIndex: number,
): { afterId?: string | null; beforeId?: string | null } {
  const rest = cards.filter((card) => card.id !== dragId)
  const index = Math.max(0, Math.min(insertionIndex, rest.length))

  if (index >= rest.length) {
    return { afterId: rest.length > 0 ? rest[rest.length - 1]?.id ?? null : null }
  }
  if (index === 0) {
    return rest.length > 0 ? { beforeId: rest[0]?.id ?? null } : { afterId: null }
  }
  return { afterId: rest[index - 1]?.id ?? null }
}

/**
 * 判断两次看板各列的卡片 id 序列是否完全一致（同列同序）。
 * 供 moveCard 做「原地投放」短路：状态、前驱与实际顺序均未变化时不写盘、
 * 不全量刷新、不报成功（交互优化计划 §10）。只比较 id 序列，不比较其余字段。
 */
export function isSameBoardOrder<
  TStatus extends string,
  TCard extends { id: string },
  TBoard extends { columns: BoardColumns<TStatus, TCard> },
>(
  a: TBoard | null,
  b: TBoard | null,
): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  const entries = Object.entries(a.columns) as [TStatus, TCard[]][]
  return entries.every(([status, cards]) => {
    const nextCards = b.columns[status] ?? []
    return cards.length === nextCards.length
      && cards.every((card, index) => card.id === nextCards[index]?.id)
  })
}
