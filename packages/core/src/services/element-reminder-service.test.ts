import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ELEMENT_REMINDER_TEMPLATE,
  evaluateElementReminder,
  fillElementReminderTemplate,
  type ChapterStat,
} from './element-reminder-service'

/** mtime 递增的章节工厂：第 i 章的 mtime = base + i（保证后写的章节更晚） */
function chapters(...names: string[]): ChapterStat[] {
  return names.map((name, index) => ({ name, lastModified: 1000 + index }))
}

describe('evaluateElementReminder 阈值判定（入口重构 W3）', () => {
  it('从未整理（elements 无文件）：全部章节算新增，达阈值即到期', () => {
    const evaluation = evaluateElementReminder(chapters('第001章', '第002章'), null)
    expect(evaluation).toEqual({ due: true, newChapters: ['第001章', '第002章'] })
  })

  it('未达阈值不到期（默认阈值 2）', () => {
    expect(evaluateElementReminder(chapters('第001章'), null).due).toBe(false)
    expect(evaluateElementReminder(chapters('第001章', '第002章', '第003章'), null, undefined, 5).due).toBe(false)
  })

  it('整理过：晚于 elements 最新 mtime 的章节才算新增', () => {
    // 三章 mtime 1000/1001/1002，上次整理在 1001.5 → 只有第003章是新增
    const evaluation = evaluateElementReminder(chapters('第001章', '第002章', '第003章'), 1001.5)
    expect(evaluation).toEqual({ due: false, newChapters: ['第003章'] })
  })

  it('新增章节名按名排序（与 mtime 顺序无关）', () => {
    const unordered: ChapterStat[] = [
      { name: '第009章', lastModified: 3000 },
      { name: '第005章', lastModified: 2000 },
    ]
    expect(evaluateElementReminder(unordered, 1000).newChapters).toEqual(['第005章', '第009章'])
  })

  it('同一批新增只提醒一次：lastRemindedAt 晚于全部新增章节则不再到期', () => {
    const stats = chapters('第003章', '第004章') // mtime 1000/1001，均晚于整理点 500
    // 提醒展示后写入 lastRemindedAt=2000（晚于两章）→ 同批不再弹
    expect(evaluateElementReminder(stats, 500, 2000).due).toBe(false)
  })

  it('上次提醒后又有新章节：状态变化再次到期（新增总数仍按整批计）', () => {
    const stats = [
      { name: '第003章', lastModified: 1000 },
      { name: '第004章', lastModified: 1001 },
      { name: '第005章', lastModified: 5000 },
    ]
    const evaluation = evaluateElementReminder(stats, 500, 2000)
    expect(evaluation.due).toBe(true)
    expect(evaluation.newChapters).toEqual(['第003章', '第004章', '第005章'])
  })

  it('空章节列表或无 chapters 目录：不到期', () => {
    expect(evaluateElementReminder([], null).due).toBe(false)
  })
})

describe('fillElementReminderTemplate 模板填充（入口重构 W3）', () => {
  it('默认模板：占位符替换为顿号分隔的章节名', () => {
    expect(fillElementReminderTemplate(DEFAULT_ELEMENT_REMINDER_TEMPLATE, ['第003章', '第004章']))
      .toBe('/管理要素 对新增章节：第003章、第004章，提取要素，要求：')
  })

  it('自定义模板：多个占位符全部替换；空章节列表替换为空串', () => {
    expect(fillElementReminderTemplate('整理 {章节名列表} 与 {章节名列表}', ['第001章']))
      .toBe('整理 第001章 与 第001章')
    expect(fillElementReminderTemplate('整理：{章节名列表}', [])).toBe('整理：')
  })

  it('模板无占位符时原样返回', () => {
    expect(fillElementReminderTemplate('/管理要素 全库核对', ['第001章'])).toBe('/管理要素 全库核对')
  })
})
