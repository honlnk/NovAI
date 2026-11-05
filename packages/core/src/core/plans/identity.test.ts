import { describe, expect, it } from 'vitest'

import {
  createPlanFileName,
  createPlanId,
  createPlanPath,
  createTitledPlanFileName,
  extractPlanSequence,
  extractPlanSlug,
  isPlanCardPath,
  isStandardPlanFileName,
  nextOrderInColumn,
  orderAfter,
  sanitizePlanTitleForFileName,
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

  it('创建文件名带可读计划名：计划-<序号>-<计划名>-<短标识>.md，路径在 plans/ 直接子级', () => {
    const path = createPlanPath(3, '# 正文标题\n\n内容')
    expect(path).toMatch(/^plans\/计划-3-正文标题-[0-9a-z]+\.md$/)
    // 首行非标题：原样进文件名
    const name = createPlanFileName(1, '一条灵感')
    expect(name).toMatch(/^计划-1-一条灵感-[0-9a-z]+\.md$/)
  })

  it('创建正文无有效名称（纯符号首行）时回退旧格式，仍唯一', () => {
    const name = createPlanFileName(2, '///\n\n正文')
    expect(name).toMatch(/^计划-2-[0-9a-z]+\.md$/)
    expect(name).not.toBe(createPlanFileName(2, '///\n\n另一正文'))
  })

  it('提取创建时序号；外部手建文件返回 null', () => {
    expect(extractPlanSequence('plans/计划-12-ab12cd34.md')).toBe(12)
    expect(extractPlanSequence('plans/随便写的.md')).toBeNull()
  })

  it('标准文件名判定：旧格式与新格式（带计划名）都算应用标准命名', () => {
    expect(isStandardPlanFileName('plans/计划-1-ab12cd34.md')).toBe(true)
    expect(isStandardPlanFileName('plans/计划-12-ab12cd34.md')).toBe(true)
    expect(isStandardPlanFileName('plans/计划-3-龙脉觉醒-ab12cd34.md')).toBe(true)
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

describe('带计划名的文件名（改名与新建共用规则）', () => {
  it('sanitizePlanTitleForFileName：中文名保留；非法字符剔除；空白压缩为下划线', () => {
    expect(sanitizePlanTitleForFileName('第三卷 龙脉觉醒')).toBe('第三卷_龙脉觉醒')
    expect(sanitizePlanTitleForFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    // 制表符属控制字符先被剔除；剩余空白压缩为单个下划线
    expect(sanitizePlanTitleForFileName('  空格\t制表  ')).toBe('空格制表')
    expect(sanitizePlanTitleForFileName(' 空格 制表 ')).toBe('空格_制表')
    // 控制字符
    expect(sanitizePlanTitleForFileName('坏\u0000名\u001f称')).toBe('坏名称')
  })

  it('sanitizePlanTitleForFileName：空名、纯非法字符、路径段返回 null', () => {
    expect(sanitizePlanTitleForFileName('')).toBeNull()
    expect(sanitizePlanTitleForFileName('   ')).toBeNull()
    expect(sanitizePlanTitleForFileName('///:::')).toBeNull()
    expect(sanitizePlanTitleForFileName('.')).toBeNull()
    expect(sanitizePlanTitleForFileName('..')).toBeNull()
  })

  it('sanitizePlanTitleForFileName：超长名称截断到 60 字符', () => {
    const long = '超'.repeat(80)
    const cleaned = sanitizePlanTitleForFileName(long)
    expect(cleaned).not.toBeNull()
    expect(cleaned!.length).toBe(60)
  })

  it('createTitledPlanFileName：保留序号与短标识，名称夹在中间', () => {
    expect(createTitledPlanFileName(3, '龙脉觉醒', 'ab12cd34')).toBe('计划-3-龙脉觉醒-ab12cd34.md')
    // 外部手建文件无序号：不编造序号
    expect(createTitledPlanFileName(null, '龙脉觉醒', 'ab12cd34')).toBe('计划-龙脉觉醒-ab12cd34.md')
  })

  it('createTitledPlanFileName：名称清理后为空时回退纯短标识形态', () => {
    expect(createTitledPlanFileName(3, '///', 'ab12cd34')).toBe('计划-3-ab12cd34.md')
    expect(createTitledPlanFileName(null, ' ', 'ab12cd34')).toBe('计划-ab12cd34.md')
  })

  it('extractPlanSlug：新旧格式都能取出短标识；非标准文件返回 null', () => {
    expect(extractPlanSlug('plans/计划-3-龙脉觉醒-ab12cd34.md')).toBe('ab12cd34')
    expect(extractPlanSlug('plans/计划-12-ab12cd34.md')).toBe('ab12cd34')
    expect(extractPlanSlug('plans/随便写的.md')).toBeNull()
  })

  it('同名计划文件名相同（靠序号区分）；同计划改名保留原序号', () => {
    const a = createTitledPlanFileName(1, '重名计划', 'aaaa1111')
    const b = createTitledPlanFileName(2, '重名计划', 'bbbb2222')
    expect(a).toBe('计划-1-重名计划-aaaa1111.md')
    expect(b).toBe('计划-2-重名计划-bbbb2222.md')
    expect(a).not.toBe(b)
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
