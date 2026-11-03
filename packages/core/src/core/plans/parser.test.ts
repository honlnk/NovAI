import { describe, expect, it } from 'vitest'

import {
  derivePlanSummary,
  derivePlanTitle,
  parsePlanFile,
  serializePlanCard,
} from './parser'
import type { PlanCard } from '../../types/plans'

function makeCard(overrides: Partial<Omit<PlanCard, 'sourcePath'>> = {}): Omit<PlanCard, 'sourcePath'> {
  return {
    id: 'plan-1-abc123',
    status: 'inbox',
    order: 0,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    body: '# 第一章伏笔\n\n林小满手腕上的银环在夜里发烫。',
    ...overrides,
  }
}

describe('parsePlanFile', () => {
  it('解析完整 frontmatter 与正文', () => {
    const content = [
      '---',
      'id: plan-1-abc',
      'status: in-progress',
      'order: 200',
      'createdAt: 2026-11-01T08:00:00.000Z',
      'updatedAt: 2026-11-02T09:30:00.000Z',
      '---',
      '',
      '# 伏笔：银环',
      '',
      '夜里会发烫。',
      '',
    ].join('\n')

    const parsed = parsePlanFile('plans/计划-1-h1.md', content)

    expect(parsed.card.id).toBe('plan-1-abc')
    expect(parsed.card.status).toBe('in-progress')
    expect(parsed.card.order).toBe(200)
    expect(parsed.card.createdAt).toBe('2026-11-01T08:00:00.000Z')
    expect(parsed.card.updatedAt).toBe('2026-11-02T09:30:00.000Z')
    expect(parsed.card.body).toBe('# 伏笔：银环\n\n夜里会发烫。')
  })

  it('缺失 frontmatter 的文件仍读取正文，状态回退收集箱', () => {
    const parsed = parsePlanFile('plans/随便.md', '只是一段灵感')

    expect(parsed.card.status).toBe('inbox')
    expect(parsed.card.id).toBe('')
    expect(parsed.card.body).toBe('只是一段灵感')
  })

  it('非法状态回退为收集箱，非法时间置空，正文不丢', () => {
    const content = [
      '---',
      'id: plan-x',
      'status: someday',
      'order: not-a-number',
      'createdAt: 不合法时间',
      'updatedAt: 2026-11-02T09:30:00.000Z',
      '---',
      '',
      '正文内容保留',
    ].join('\n')

    const parsed = parsePlanFile('plans/计划-2-h2.md', content)

    expect(parsed.card.status).toBe('inbox')
    expect(parsed.card.order).toBe(0)
    expect(parsed.card.createdAt).toBe('')
    expect(parsed.card.updatedAt).toBe('2026-11-02T09:30:00.000Z')
    expect(parsed.card.body).toBe('正文内容保留')
  })

  it('CRLF 换行与 frontmatter 未闭合时不丢正文', () => {
    const crlf = '---\r\nid: plan-crlf\r\nstatus: planned\r\n---\r\n\r\n跨平台的正文'
    expect(parsePlanFile('plans/a.md', crlf).card.body).toBe('跨平台的正文')

    const unclosed = '---\nid: plan-unclosed\nstatus: planned\n\n没有闭合的正文'
    const parsed = parsePlanFile('plans/b.md', unclosed)
    expect(parsed.card.id).toBe('')
    expect(parsed.card.body).toContain('没有闭合的正文')
  })

  it('五种合法状态都能解析', () => {
    for (const status of ['inbox', 'planned', 'in-progress', 'done', 'on-hold'] as const) {
      const content = `---\nid: p\nstatus: ${status}\n---\n\n正文`
      expect(parsePlanFile('plans/x.md', content).card.status).toBe(status)
    }
  })
})

describe('serializePlanCard', () => {
  it('序列化为 frontmatter + 正文，且能被重新解析（往返一致）', () => {
    const card = makeCard()
    const serialized = serializePlanCard(card)
    const parsed = parsePlanFile('plans/计划-1-h1.md', serialized)

    expect(parsed.card).toEqual(card)
  })

  it('字段顺序固定：id/status/order/createdAt/updatedAt', () => {
    const lines = serializePlanCard(makeCard()).split('\n')
    expect(lines.slice(0, 7)).toEqual([
      '---',
      'id: plan-1-abc123',
      'status: inbox',
      'order: 0',
      'createdAt: 2026-11-03T10:00:00.000Z',
      'updatedAt: 2026-11-03T10:00:00.000Z',
      '---',
    ])
  })
})

describe('derivePlanTitle', () => {
  it('取首个非空行并去掉行首 Markdown 标题标记', () => {
    expect(derivePlanTitle('# 大标题\n\n正文')).toBe('大标题')
    expect(derivePlanTitle('###### 六级标题\n正文')).toBe('六级标题')
    expect(derivePlanTitle('\n\n  \n第一行正文')).toBe('第一行正文')
  })

  it('空正文返回空标题', () => {
    expect(derivePlanTitle('')).toBe('')
    expect(derivePlanTitle('\n\n  \n')).toBe('')
  })

  it('标题变化不影响稳定标识（标题只是派生值）', () => {
    const before = parsePlanFile('plans/a.md', '---\nid: p\n---\n\n# 旧标题')
    const after = parsePlanFile('plans/a.md', '---\nid: p\n---\n\n# 新标题')
    expect(before.card.id).toBe(after.card.id)
    expect(derivePlanTitle(before.card.body)).toBe('旧标题')
    expect(derivePlanTitle(after.card.body)).toBe('新标题')
  })
})

describe('derivePlanSummary', () => {
  it('超长首行截断加省略号', () => {
    const long = '很长的灵感'.repeat(30)
    const summary = derivePlanSummary(long)
    expect(summary.length).toBeLessThanOrEqual(81)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('短正文原样返回首行', () => {
    expect(derivePlanSummary('# 标题\n正文第二行')).toBe('# 标题')
  })
})
