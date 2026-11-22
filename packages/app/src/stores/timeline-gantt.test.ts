import { describe, expect, it } from 'vitest'

import {
  GANTT_MAX_ROWS,
  ganttColumnX,
  layoutTimelineGantt,
  type GanttEntry,
  type GanttMeasure,
} from './timeline-gantt'

/** 固定测宽：每字宽 = 字号（不依赖 DOM，可精确推算排布） */
const measure: GanttMeasure = (text, fontSize) => text.length * fontSize

let seq = 0
function point(index: number, title = '甲', dateLabel = ''): GanttEntry {
  seq += 1
  return { eventId: `EVT-p${seq}`, kind: 'point', title, dateLabel, startIndex: index, endIndex: index, matched: true }
}
function span(startIndex: number, endIndex: number, title = '甲'): GanttEntry {
  seq += 1
  return { eventId: `EVT-s${seq}`, kind: 'span', title, dateLabel: '', startIndex, endIndex, matched: true }
}
function rows(layout: ReturnType<typeof layoutTimelineGantt>): number[] {
  return layout.items.map((item) => item.row)
}

describe('layoutTimelineGantt（甘特排布）', () => {
  it('互不重叠的点事件（列宽足够）全部落在 1 行', () => {
    const layout = layoutTimelineGantt([point(0), point(1), point(2), point(3)], 4, { minStep: 96, measure })
    expect(layout.rowCount).toBe(1)
    expect(rows(layout)).toEqual([0, 0, 0, 0])
    expect(layout.step).toBe(96)
  })

  it('重叠区间分到不同行；首尾不重叠的区间复用已有行', () => {
    const layout = layoutTimelineGantt([span(0, 3), span(1, 2), span(4, 5)], 6, { minStep: 96, measure })
    expect(layout.rowCount).toBe(2)
    // 第三个区间两行都能放：条目数相同，选最后右缘更靠左的行 1
    expect(rows(layout)).toEqual([0, 1, 1])
  })

  it('点事件落在区间覆盖范围内 → 与该区间不同行', () => {
    const layout = layoutTimelineGantt([span(0, 2), point(1)], 3, { minStep: 96, measure })
    expect(layout.items[0]!.row).not.toBe(layout.items[1]!.row)
    expect(layout.rowCount).toBe(2)
  })

  it('均匀分配：多行都能放时选条目最少的行（不是固定塞第一行）', () => {
    // A、B 同列区间分占行 0/1；P 两行皆可 → 平局取行 0；Q 两行皆可 → 行 0 已 2 条，选行 1
    const layout = layoutTimelineGantt([span(0, 1), span(0, 1), point(2), point(4)], 5, { minStep: 96, measure })
    expect(rows(layout)).toEqual([0, 1, 0, 1])
  })

  it('标题相撞的相邻点事件分行；日期写在表头，不计入标题占位', () => {
    const long = layoutTimelineGantt([point(0, '一二三四五六七八九十'), point(1, '一二三四五六七八九十')], 2, { minStep: 96, measure })
    expect(long.rowCount).toBe(2)

    // 四字标题：右缘 x0+61，+12 间隙 ≤ 下一个左缘 x0+89 → 同行；带短日期也不改变行排布
    const noDate = layoutTimelineGantt([point(0, '一二三四'), point(1, '一二三四')], 2, { minStep: 96, measure })
    expect(noDate.rowCount).toBe(1)
    const withDate = layoutTimelineGantt([point(0, '一二三四', 'ab'), point(1, '一二三四')], 2, { minStep: 96, measure })
    expect(withDate.rowCount).toBe(1)
    expect(withDate.items[0]!.right).toBe(noDate.items[0]!.right)
  })

  it('表头日期：落在事件起始列中心；相邻两列日期放不下时加宽列宽，互不重叠', () => {
    // 「苍穹历·320年」8 字 × 11px = 88px；相邻两列需 (88 + 88) / 2 + 10 = 98px
    const layout = layoutTimelineGantt([point(0, '甲', '苍穹历·320年'), point(1, '乙', '苍穹历·321年')], 2, { minStep: 48, measure })
    expect(layout.step).toBe(98)
    expect(layout.labels.map((label) => label.text)).toEqual(['苍穹历·320年', '苍穹历·321年'])
    const [first, second] = layout.labels
    expect(first!.x).toBe(ganttColumnX(0, 98))
    expect(first!.x + first!.width / 2 + 10).toBeLessThanOrEqual(second!.x - second!.width / 2)
    // 首列日期左缘不被截断
    expect(first!.x - first!.width / 2).toBeGreaterThanOrEqual(4)
    expect(layout.width).toBeGreaterThanOrEqual(second!.x + second!.width / 2)
  })

  it('表头日期：区间写在开始列；同一日期连续出现时每列都写；无日期的列不产生标签', () => {
    const layout = layoutTimelineGantt([
      span(0, 3, '修行'),
      point(1, '甲'),
      point(2, '乙', '苍穹历·320年'),
      point(4, '丙', '苍穹历·320年'),
    ].map((entry, index) => (index === 0 ? { ...entry, dateLabel: '苍穹历·319年' } : entry)), 5, { minStep: 96, measure })
    expect(layout.labels.map((label) => [label.index, label.text])).toEqual([
      [0, '苍穹历·319年'],
      [2, '苍穹历·320年'],
      [4, '苍穹历·320年'],
    ])
  })

  it('超过 6 行的需求 → 加宽列宽而不加行', () => {
    // 30 字标题：点右缘 = x + 7 + 6 + 360，复用同行需下一条左缘（x' − 7）≥ 右缘 + 12，
    // 即相隔列数 × 列宽 ≥ 392。列宽 48 需相隔 9 列（9 行）；步进 8 加宽，72 时相隔 6 列即可 → 正好 6 行
    const title = '字'.repeat(30)
    const entries = Array.from({ length: 10 }, (_, index) => point(index, title))
    const layout = layoutTimelineGantt(entries, 10, { minStep: 48, measure })
    expect(layout.rowCount).toBeLessThanOrEqual(GANTT_MAX_ROWS)
    expect(layout.rowCount).toBe(6)
    expect(layout.step).toBe(72)
  })

  it('实际列宽永不小于滑块设定的最小列宽', () => {
    const layout = layoutTimelineGantt([point(0), point(1)], 2, { minStep: 200, measure })
    expect(layout.step).toBe(200)
    expect(layout.items[1]!.x).toBe(ganttColumnX(1, 200))
  })

  it('深度兜底：7 层嵌套区间 → 7 行，算法终止', () => {
    const entries = Array.from({ length: 7 }, (_, index) => span(index, 13 - index))
    const layout = layoutTimelineGantt(entries, 14, { minStep: 48, measure })
    expect(layout.rowCount).toBe(7)
    expect(new Set(rows(layout)).size).toBe(7)
  })

  it('区间标题比横条长：横条范围不变，占位延伸到文字末尾', () => {
    const title = '字'.repeat(20)
    const layout = layoutTimelineGantt([span(0, 1, title)], 2, { minStep: 96, measure })
    const item = layout.items[0]!
    expect(item.barLeft).toBe(ganttColumnX(0, 96) - 8)
    expect(item.barRight).toBe(ganttColumnX(1, 96) + 8)
    expect(item.right).toBe(item.barLeft + 8 + 240 + 8)
    expect(layout.width).toBeGreaterThanOrEqual(item.right)
  })

  it('空输入 → 0 行 0 条目', () => {
    const layout = layoutTimelineGantt([], 0, { minStep: 96, measure })
    expect(layout.items).toEqual([])
    expect(layout.rowCount).toBe(0)
  })

  it('确定性：同一输入两次排布结果全等；筛选命中态不影响排布', () => {
    const entries = [span(0, 4), point(1, '较长的标题文字'), point(2), span(3, 6), point(5, '标题', '苍穹历·320年')]
    const first = layoutTimelineGantt(entries, 7, { minStep: 48, measure })
    const second = layoutTimelineGantt(entries, 7, { minStep: 48, measure })
    expect(second).toEqual(first)

    const dimmed = layoutTimelineGantt(entries.map((entry) => ({ ...entry, matched: false })), 7, { minStep: 48, measure })
    expect(rows(dimmed)).toEqual(rows(first))
    expect(dimmed.step).toBe(first.step)
  })
})
