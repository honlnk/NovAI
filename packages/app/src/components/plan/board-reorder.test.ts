import { describe, expect, it } from 'vitest'

import type { PlanBoardView, PlanCardSummaryView } from '@novai/core/services/types'

import { moveCardInBoard, isSameBoardOrder } from './board-reorder'

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

  it('锚点不在目标列或卡片不存在：本地视图不动，等服务端结果', () => {
    const source = board({ inbox: [card('a', 'inbox', 0)], planned: [card('b', 'planned', 0)] })

    expect(moveCardInBoard(source, 'a', 'planned', 'missing')).toBe(source)
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
