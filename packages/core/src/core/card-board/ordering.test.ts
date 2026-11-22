import { describe, expect, it } from 'vitest'

import { nextOrderInColumn, orderAfter, orderBefore, sortBoardCards } from './ordering'

type Card = { id: string; status: string; order: number; createdAt: string }

function card(id: string, status: string, order: number, createdAt = ''): Card {
  return { id, status, order, createdAt }
}

describe('sortBoardCards', () => {
  it('order 升序；同 order 按 createdAt、id 确定排序', () => {
    const sorted = sortBoardCards([
      card('b', 'planted', 200),
      card('a', 'planted', 100),
      card('c', 'planted', 100, '2026-01-02'),
      card('d', 'planted', 100, '2026-01-01'),
    ])

    // 同 order 100：a（createdAt 空串最早）→ d → c；b order 200 最后
    expect(sorted.map((item) => item.id)).toEqual(['a', 'd', 'c', 'b'])
  })

  it('不修改原数组', () => {
    const input = [card('b', 'planted', 2), card('a', 'planted', 1)]
    sortBoardCards(input)
    expect(input.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('nextOrderInColumn', () => {
  it('空列取 0；有卡取最大 order + 步长', () => {
    const cards = [card('a', 'todo', 100), card('b', 'todo', 350), card('c', 'other', 900)]
    expect(nextOrderInColumn([], 'todo')).toBe(0)
    expect(nextOrderInColumn(cards, 'todo')).toBe(450)
    expect(nextOrderInColumn(cards, 'other')).toBe(1000)
    expect(nextOrderInColumn(cards, 'todo', 10)).toBe(360)
  })
})

describe('orderAfter', () => {
  const column = [
    card('a', 'todo', 100),
    card('b', 'todo', 200),
    card('c', 'todo', 300),
  ]

  it('afterId=null 取列末尾 + 步长；空列取 0', () => {
    expect(orderAfter(column, 'todo', null)).toBe(400)
    expect(orderAfter([], 'todo', null)).toBe(0)
  })

  it('插到两卡之间取中点', () => {
    expect(orderAfter(column, 'todo', 'a')).toBe(150)
    expect(orderAfter(column, 'todo', 'b')).toBe(250)
  })

  it('末卡之后取 order + 步长', () => {
    expect(orderAfter(column, 'todo', 'c')).toBe(400)
  })

  it('afterId 不在目标列按列末尾处理', () => {
    expect(orderAfter(column, 'todo', 'missing')).toBe(400)
  })
})

describe('orderBefore', () => {
  const column = [
    card('a', 'todo', 100),
    card('b', 'todo', 200),
    card('c', 'todo', 300),
  ]

  it('beforeId=null 或首卡之前取列首 - 步长（order 允许为负）', () => {
    expect(orderBefore(column, 'todo', null)).toBe(0)
    expect(orderBefore(column, 'todo', 'a')).toBe(0)
    expect(orderBefore([], 'todo', null)).toBe(0)
  })

  it('插到两卡之间取中点', () => {
    expect(orderBefore(column, 'todo', 'b')).toBe(150)
    expect(orderBefore(column, 'todo', 'c')).toBe(250)
  })

  it('beforeId 不在目标列按列末尾处理（与 orderAfter 同口径）', () => {
    expect(orderBefore(column, 'todo', 'missing')).toBe(400)
  })
})
