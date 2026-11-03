import { describe, expect, it } from 'vitest'

import {
  createPlanFileName,
  createPlanId,
  createPlanPath,
  extractPlanSequence,
  isPlanCardPath,
  isStandardPlanFileName,
  nextOrderInColumn,
  orderAfter,
  sortPlanCards,
} from './identity'
import type { PlanCard } from '../../types/plans'

function card(overrides: Partial<Pick<PlanCard, 'id' | 'order' | 'createdAt' | 'status'>>): PlanCard {
  return {
    id: 'plan-x',
    status: 'inbox',
    order: 0,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    body: 'x',
    sourcePath: 'plans/x.md',
    ...overrides,
  }
}

describe('稳定标识与文件名', () => {
  it('创建标识带时间戳与随机串，两次生成不重复', () => {
    const a = createPlanId()
    const b = createPlanId()
    expect(a).toMatch(/^plan-\d+-[0-9a-z]+$/)
    expect(a).not.toBe(b)
  })

  it('文件名形如 计划-<序号>-<短标识>.md，路径在 plans/ 直接子级', () => {
    const path = createPlanPath(3, '正文内容')
    expect(path).toMatch(/^plans\/计划-3-[0-9a-z]+\.md$/)
    const name = createPlanFileName(1, '内容')
    expect(name).toMatch(/^计划-1-[0-9a-z]+\.md$/)
  })

  it('提取创建时序号；外部手建文件返回 null', () => {
    expect(extractPlanSequence('plans/计划-12-ab12cd34.md')).toBe(12)
    expect(extractPlanSequence('plans/随便写的.md')).toBeNull()
  })

  it('标准文件名判定', () => {
    expect(isStandardPlanFileName('plans/计划-1-ab12cd34.md')).toBe(true)
    expect(isStandardPlanFileName('plans/计划-12-ab12cd34.md')).toBe(true)
    expect(isStandardPlanFileName('plans/notes.md')).toBe(false)
  })

  it('isPlanCardPath 只收 plans/ 直接子级 .md', () => {
    expect(isPlanCardPath('plans/计划-1-ab12cd34.md')).toBe(true)
    expect(isPlanCardPath('plans/note.md')).toBe(true)
    expect(isPlanCardPath('plans/sub/dir.md')).toBe(false)
    expect(isPlanCardPath('plans/readme.txt')).toBe(false)
    expect(isPlanCardPath('chapters/第一章.md')).toBe(false)
    expect(isPlanCardPath('plansx/a.md')).toBe(false)
  })
})

describe('同列排序', () => {
  it('order 升序', () => {
    const sorted = sortPlanCards([
      card({ id: 'b', order: 200 }),
      card({ id: 'a', order: 100 }),
    ])
    expect(sorted.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('order 相同按 createdAt，再按 id，结果确定', () => {
    const first = sortPlanCards([
      card({ id: 'b', order: 100, createdAt: '2026-11-03T10:00:00.000Z' }),
      card({ id: 'a', order: 100, createdAt: '2026-11-03T09:00:00.000Z' }),
      card({ id: 'c', order: 100, createdAt: '2026-11-03T09:00:00.000Z' }),
    ])
    expect(first.map((c) => c.id)).toEqual(['a', 'c', 'b'])

    const second = sortPlanCards([
      card({ id: 'c', order: 100, createdAt: '2026-11-03T09:00:00.000Z' }),
      card({ id: 'a', order: 100, createdAt: '2026-11-03T09:00:00.000Z' }),
    ])
    expect(second.map((c) => c.id)).toEqual(['a', 'c'])
  })
})

describe('order 计算', () => {
  it('空列从 0 开始；追加按步长递增', () => {
    expect(nextOrderInColumn([], 'inbox')).toBe(0)

    const column = [card({ id: 'a', status: 'inbox', order: 0 })]
    expect(nextOrderInColumn(column, 'inbox')).toBe(100)
    // 其他列不影响
    expect(nextOrderInColumn([card({ id: 'x', status: 'done', order: 900 })], 'inbox')).toBe(0)
  })

  it('拖到两卡之间取中点（可插入间隔，不重写整列）', () => {
    const column = [
      card({ id: 'a', status: 'inbox', order: 0 }),
      card({ id: 'b', status: 'inbox', order: 100 }),
    ]
    expect(orderAfter(column, 'inbox', 'a')).toBe(50)
  })

  it('拖到列尾（afterId=null 或最后一张之后）按步长追加', () => {
    const column = [
      card({ id: 'a', status: 'inbox', order: 0 }),
      card({ id: 'b', status: 'inbox', order: 50 }),
    ]
    expect(orderAfter(column, 'inbox', null)).toBe(150)
    expect(orderAfter(column, 'inbox', 'b')).toBe(150)
  })

  it('afterId 指向不存在卡片时按列末尾处理', () => {
    const column = [card({ id: 'a', status: 'inbox', order: 40 })]
    expect(orderAfter(column, 'inbox', 'ghost')).toBe(140)
  })
})
