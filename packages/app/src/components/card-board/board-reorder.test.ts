import { describe, expect, it } from 'vitest'

import type { PlanBoardView, PlanCardSummaryView } from '@novai/core/services/types'

import {
  boardDropInsertionIndex,
  boardMovePositionForInsertion,
  isSameBoardOrder,
  moveCardInBoard,
} from './board-reorder'

function card(id: string, status: PlanCardSummaryView['status'], order: number): PlanCardSummaryView {
  return {
    id,
    status,
    order,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    title: `卡片${id}`,
    summary: `卡片${id}`,
    sourcePath: `plans/计划-1-${id}.md`,
  }
}

function board(columns: Partial<Record<PlanCardSummaryView['status'], PlanCardSummaryView[]>>): PlanBoardView {
  return {
    columns: {
      inbox: columns.inbox ?? [],
      planned: columns.planned ?? [],
      'in-progress': columns['in-progress'] ?? [],
      done: columns.done ?? [],
      'on-hold': columns['on-hold'] ?? [],
    },
    issues: [],
  }
}

describe('看板本地重排（拖动即时反馈）', () => {
  it('跨列拖到列尾：源列移除、目标列追加，状态同步为目标列', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], done: [card('d', 'done', 0)] })

    const next = moveCardInBoard(source, 'a', 'done', null)

    expect(next.columns.inbox.map((item) => item.id)).toEqual([])
    expect(next.columns.done.map((item) => item.id)).toEqual(['d', 'a'])
    expect(next.columns.done[1]?.status).toBe('done')
  })

  it('同列拖到某卡之后：按锚点插入，不动其他列', () => {
    const source = board({ planned: [card('a', 'planned', 0), card('b', 'planned', 100), card('c', 'planned', 200)] })

    const next = moveCardInBoard(source, 'c', 'planned', 'a')

    expect(next.columns.planned.map((item) => item.id)).toEqual(['a', 'c', 'b'])
    expect(next.columns.inbox).toEqual([])
  })

  it('拖到另一列的锚点之后：源列移除、目标列按锚点插入', () => {
    const source = board({
      inbox: [card('a', 'inbox', 0)],
      planned: [card('b', 'planned', 0), card('c', 'planned', 100)],
    })

    const next = moveCardInBoard(source, 'a', 'planned', 'b')

    expect(next.columns.inbox.map((item) => item.id)).toEqual([])
    expect(next.columns.planned.map((item) => item.id)).toEqual(['b', 'a', 'c'])
    expect(next.columns.planned[1]?.status).toBe('planned')
  })

  it('同列拖到首卡之前：插到列首，原地投放时各列顺序不变', () => {
    const source = board({ planned: [card('a', 'planned', 0), card('b', 'planned', 100), card('c', 'planned', 200)] })

    const next = moveCardInBoard(source, 'c', 'planned', null, 'a')

    expect(next.columns.planned.map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(isSameBoardOrder(source, moveCardInBoard(source, 'a', 'planned', null, 'b'))).toBe(true)
  })

  it('拖到另一列列首（beforeId=null）：源列移除、目标列开头插入', () => {
    const source = board({
      inbox: [card('a', 'inbox', 0)],
      planned: [card('b', 'planned', 0)],
    })

    const next = moveCardInBoard(source, 'a', 'planned', null, null)

    expect(next.columns.inbox.map((item) => item.id)).toEqual([])
    expect(next.columns.planned.map((item) => item.id)).toEqual(['a', 'b'])
    expect(next.columns.planned[0]?.status).toBe('planned')
  })

  it('锚点不在目标列或卡片不存在：本地视图不动，等服务端结果', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], planned: [card('b', 'planned', 0)] })

    expect(moveCardInBoard(source, 'a', 'planned', 'missing')).toBe(source)
    expect(moveCardInBoard(source, 'a', 'planned', null, 'missing')).toBe(source)
    expect(moveCardInBoard(source, 'missing', 'planned', null)).toBe(source)
    expect(moveCardInBoard(source, 'a', 'planned', 'a')).toBe(source)
  })

  it('不修改入参看板（旧对象保留给失败回滚路径）', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], planned: [card('b', 'planned', 0)] })

    moveCardInBoard(source, 'a', 'planned', 'b')

    expect(source.columns.inbox.map((item) => item.id)).toEqual(['a'])
    expect(source.columns.planned.map((item) => item.id)).toEqual(['b'])
  })
})

describe('isSameBoardOrder（原地投放短路）', () => {
  it('同引用直接判等', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)] })

    expect(isSameBoardOrder(source, source)).toBe(true)
  })

  it('各列 id 序列完全一致时为真（即使对象是重排新建的）', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], planned: [card('b', 'planned', 0)] })
    const next = moveCardInBoard(source, 'a', 'inbox', null)

    expect(isSameBoardOrder(source, next)).toBe(true)
  })

  it('列内顺序变化为假', () => {
    const source = board({ planned: [card('a', 'planned', 0), card('b', 'planned', 100)] })
    const next = moveCardInBoard(source, 'a', 'planned', 'b')

    expect(next.columns.planned.map((item) => item.id)).toEqual(['b', 'a'])
    expect(isSameBoardOrder(source, next)).toBe(false)
  })

  it('跨列移动为假', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], done: [] })
    const next = moveCardInBoard(source, 'a', 'done', null)

    expect(isSameBoardOrder(source, next)).toBe(false)
  })

  it('null 与空看板边界：null 参与比较为假，两侧空列为真', () => {
    const empty = board({})

    expect(isSameBoardOrder(null, empty)).toBe(false)
    expect(isSameBoardOrder(empty, null)).toBe(false)
    expect(isSameBoardOrder(null, null)).toBe(true)
    expect(isSameBoardOrder(empty, board({}))).toBe(true)
  })
})

describe('boardDropInsertionIndex（卡片中心线落点）', () => {
  const rects = [
    { top: 0, height: 80 },
    { top: 88, height: 80 },
    { top: 176, height: 80 },
  ]

  it('中心线上方插它之前、中心线（含）下方越过它', () => {
    expect(boardDropInsertionIndex(rects, 10)).toBe(0)
    expect(boardDropInsertionIndex(rects, 39)).toBe(0)
    expect(boardDropInsertionIndex(rects, 40)).toBe(1)
    expect(boardDropInsertionIndex(rects, 100)).toBe(1)
    expect(boardDropInsertionIndex(rects, 128)).toBe(2)
    expect(boardDropInsertionIndex(rects, 300)).toBe(3)
  })

  it('空列（无卡片几何）落到唯一插入位 0', () => {
    expect(boardDropInsertionIndex([], 123)).toBe(0)
  })
})

describe('boardMovePositionForInsertion（插入序号 → 移动参数）', () => {
  const cards = [card('a', 'planned', 0), card('b', 'planned', 100), card('drag', 'planned', 200)]

  it('列首用 beforeId、列中/列尾用 afterId；被拖卡片不参与锚点计算', () => {
    expect(boardMovePositionForInsertion(cards, 'drag', 0)).toEqual({ beforeId: 'a' })
    expect(boardMovePositionForInsertion(cards, 'drag', 1)).toEqual({ afterId: 'a' })
    expect(boardMovePositionForInsertion(cards, 'drag', 2)).toEqual({ afterId: 'b' })
  })

  it('空列与越界序号收敛到列尾（afterId=null）', () => {
    expect(boardMovePositionForInsertion([], 'drag', 0)).toEqual({ afterId: null })
    expect(boardMovePositionForInsertion(cards, 'drag', 99)).toEqual({ afterId: 'b' })
  })
})
