import { describe, expect, it } from 'vitest'

import { buildLineDiffRows, countLineDiff } from './text-diff'

/**
 * 两版本行级对比（数据安全计划 §3-6 冲突界面的差异呈现）：
 * equal 行两侧一致；left 行仅草稿有（红，采纳磁盘会丢）；right 行仅磁盘有（绿，AI 的修改）。
 * 非左行按序拼接必须还原 right 文本、非右行按序拼接必须还原 left 文本（排版硬约束）。
 */
describe('buildLineDiffRows 行级对比', () => {
  it('单行替换：红行在前、绿行在后，公共前后缀保持 equal', () => {
    const rows = buildLineDiffRows('第一段\n旧的中段\n最后一段', '第一段\n新的中段\n最后一段')
    expect(rows).toEqual([
      { kind: 'equal', text: '第一段' },
      { kind: 'left', text: '旧的中段' },
      { kind: 'right', text: '新的中段' },
      { kind: 'equal', text: '最后一段' },
    ])
  })

  it('纯新增（磁盘比草稿多了 AI 补写的一段）', () => {
    const rows = buildLineDiffRows('开头\n结尾', '开头\nAI 补写的中段\n结尾')
    expect(rows).toContainEqual({ kind: 'right', text: 'AI 补写的中段' })
    expect(rows.filter((row) => row.kind === 'left')).toEqual([])
  })

  it('纯删除（草稿删掉了一段，磁盘仍有）', () => {
    const rows = buildLineDiffRows('开头\n将被我删掉\n结尾', '开头\n结尾')
    expect(rows).toContainEqual({ kind: 'left', text: '将被我删掉' })
    expect(rows.filter((row) => row.kind === 'right')).toEqual([])
  })

  it('完全一致时全部 equal', () => {
    const rows = buildLineDiffRows('同文\n同文', '同文\n同文')
    expect(rows.every((row) => row.kind === 'equal')).toBe(true)
  })

  it('排版硬约束：按行拼接还原两侧原文', () => {
    const left = '段一\n段二甲\n段三\n段四\n段五'
    const right = '段一\n段二乙\n段三改\n段四\n段六'
    const rows = buildLineDiffRows(left, right)
    const rebuiltLeft = rows.filter((r) => r.kind !== 'right').map((r) => r.text).join('\n')
    const rebuiltRight = rows.filter((r) => r.kind !== 'left').map((r) => r.text).join('\n')
    expect(rebuiltLeft).toBe(left)
    expect(rebuiltRight).toBe(right)
  })

  it('空行参与对比（小说正文常见空行分段）', () => {
    const rows = buildLineDiffRows('段一\n\n段三', '段一\n\n段二\n\n段三')
    expect(rows).toContainEqual({ kind: 'right', text: '段二' })
  })

  it('一侧为空：整块红或整块绿', () => {
    expect(buildLineDiffRows('', '新内容')).toEqual([{ kind: 'right', text: '新内容' }])
    expect(buildLineDiffRows('旧内容', '')).toEqual([{ kind: 'left', text: '旧内容' }])
  })

  it('超大规模中段退化为整块对比（不逐行对齐，不卡界面）', () => {
    const bigLeft = Array.from({ length: 3000 }, (_, i) => `左${i}`).join('\n')
    const bigRight = Array.from({ length: 3000 }, (_, i) => `右${i}`).join('\n')
    const rows = buildLineDiffRows(bigLeft, bigRight)
    // 退化模式：红块截 400 行 + 折叠提示，绿块同
    const foldRows = rows.filter((row) => row.text.includes('已折叠'))
    expect(foldRows.length).toBe(2)
    expect(rows.filter((row) => row.kind === 'left').length).toBe(401)
    expect(rows.filter((row) => row.kind === 'right').length).toBe(401)
  })

  it('countLineDiff 统计两侧独有行数', () => {
    const stats = countLineDiff('A\nB\nC', 'A\nX\nY\nC')
    expect(stats).toEqual({ onlyLeft: 1, onlyRight: 2 })
  })
})
