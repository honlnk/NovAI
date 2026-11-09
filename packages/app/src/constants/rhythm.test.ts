import { describe, expect, it } from 'vitest'

import type { RhythmCardSummaryView } from '@novai/core/services/types'
import {
  chapterRhythmCard,
  conflictIntensityClass,
  isRhythmReorderOnly,
  rhythmChapterNumber,
  rhythmDisplayColumns,
} from './rhythm'

function summary(partial: Partial<RhythmCardSummaryView>): RhythmCardSummaryView {
  return {
    id: 'R-001',
    name: '第083章节奏',
    status: 'planned',
    order: 100,
    createdAt: '',
    updatedAt: '',
    chapterRef: '第二卷/第083章',
    volume: '第二卷',
    plannedConflict: 3,
    plannedMood: '温馨',
    plannedHook: '无',
    plannedPayoff: '收获',
    actualConflict: null,
    actualMood: null,
    actualHook: null,
    actualPayoff: null,
    deviationFlag: false,
    summary: '',
    sourcePath: 'rhythm/R-001-第083章节奏.md',
    ...partial,
  }
}

describe('rhythmDisplayColumns', () => {
  it('固定三列（规划中/已写/偏差），key 即状态；board 为 null 返回空数组', () => {
    expect(rhythmDisplayColumns(null)).toEqual([])

    const columns = rhythmDisplayColumns({
      columns: {
        planned: [summary({})],
        written: [],
        deviated: [summary({ id: 'R-009', status: 'deviated' })],
      },
    })
    expect(columns.map((column) => column.key)).toEqual(['planned', 'written', 'deviated'])
    expect(columns.map((column) => column.label)).toEqual(['规划中', '已写', '偏差'])
    expect(columns[0]!.cards).toHaveLength(1)
    expect(columns[2]!.cards).toHaveLength(1)
  })
})

describe('isRhythmReorderOnly（拖拽只放行同列重排）', () => {
  const board = {
    columns: {
      planned: [summary({ id: 'R-001' })],
      written: [summary({ id: 'R-002', status: 'written' })],
      deviated: [summary({ id: 'R-003', status: 'deviated' })],
    },
  }

  it('同列重排放行（偏差列内、规划列内都算重排）', () => {
    expect(isRhythmReorderOnly(board, 'R-003', 'deviated')).toBe(true)
    expect(isRhythmReorderOnly(board, 'R-001', 'planned')).toBe(true)
  })

  it('跨列一律拒绝：偏差不可拖出，规划中/已写不可互拖', () => {
    expect(isRhythmReorderOnly(board, 'R-003', 'planned')).toBe(false)
    expect(isRhythmReorderOnly(board, 'R-003', 'written')).toBe(false)
    expect(isRhythmReorderOnly(board, 'R-001', 'written')).toBe(false)
    expect(isRhythmReorderOnly(board, 'R-002', 'planned')).toBe(false)
  })

  it('未知列或 board 为 null 拒绝；卡片不在任何列也拒绝', () => {
    expect(isRhythmReorderOnly(board, 'R-001', 'unknown')).toBe(false)
    expect(isRhythmReorderOnly(null, 'R-001', 'planned')).toBe(false)
    expect(isRhythmReorderOnly(board, 'R-999', 'planned')).toBe(false)
  })
})

describe('conflictIntensityClass（1~3 绿 / 4~6 黄 / 7~10 红）', () => {
  it('三档边界', () => {
    expect(conflictIntensityClass(1)).toContain('emerald')
    expect(conflictIntensityClass(3)).toContain('emerald')
    expect(conflictIntensityClass(4)).toContain('amber')
    expect(conflictIntensityClass(6)).toContain('amber')
    expect(conflictIntensityClass(7)).toContain('red')
    expect(conflictIntensityClass(10)).toContain('red')
  })
})

describe('rhythmChapterNumber / chapterRhythmCard', () => {
  it('从章节引用或文件路径解析章号；无法解析返回 null', () => {
    expect(rhythmChapterNumber('第二卷/第083章')).toBe(83)
    expect(rhythmChapterNumber('chapters/第二卷/第083章-夜行.txt')).toBe(83)
    expect(rhythmChapterNumber('第0001章')).toBe(1)
    expect(rhythmChapterNumber('chapters/序章.md')).toBeNull()
    expect(rhythmChapterNumber('')).toBeNull()
  })

  it('章号命中返回本章卡；多卡取第一张（一章一卡假设）', () => {
    const cards = [
      summary({ chapterRef: '第二卷/第083章' }),
      summary({ id: 'R-002', chapterRef: '第二卷/第084章' }),
    ]
    expect(chapterRhythmCard(cards, 'chapters/第二卷/第084章-终局.md')?.id).toBe('R-002')
    expect(chapterRhythmCard(cards, 'chapters/第二卷/第083章-夜行.md')?.id).toBe('R-001')
  })

  it('无卡、路径为空、章号不可解析时返回 null', () => {
    expect(chapterRhythmCard([], 'chapters/第二卷/第083章.md')).toBeNull()
    expect(chapterRhythmCard([summary({})], null)).toBeNull()
    expect(chapterRhythmCard([summary({})], 'chapters/序章.md')).toBeNull()
  })
})
