import { describe, expect, it } from 'vitest'

import {
  computeReplaceRanges,
  countTextLines,
  lineIndexOf,
} from './change-coords'

/**
 * 变更定位坐标（§7）：行号 1-based 闭区间；空范围 end = start - 1。
 * 界面据此定位红绿差异，不自行搜索文本猜位置。
 */
describe('countTextLines / lineIndexOf', () => {
  it('空串 0 行；单行 1 行；尾随换行含空末行', () => {
    expect(countTextLines('')).toBe(0)
    expect(countTextLines('a')).toBe(1)
    expect(countTextLines('a\nb')).toBe(2)
    expect(countTextLines('a\n')).toBe(2)
  })

  it('lineIndexOf：1-based，换行符算下一行的开启', () => {
    const content = '第一行\n第二行\n第三行'
    expect(lineIndexOf(content, 0)).toBe(1)
    expect(lineIndexOf(content, 3)).toBe(1) // 换行符本身
    expect(lineIndexOf(content, 4)).toBe(2)
    expect(lineIndexOf(content, content.length)).toBe(3)
  })
})

describe('computeReplaceRanges', () => {
  it('单处替换：新旧行数相同', () => {
    const content = 'l1\nl2\nl3\nl4'
    expect(computeReplaceRanges(content, 'l2', '改', false)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 },
    ])
  })

  it('替换后变长/变短：newEnd 随新行数伸缩', () => {
    const content = 'l1\nl2\nl3'
    expect(computeReplaceRanges(content, 'l2', 'x\ny\nz', false)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 4 },
    ])
    expect(computeReplaceRanges(content, 'l2', '短', false)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 },
    ])
  })

  it('多行片段替换', () => {
    const content = 'a\nb\nc\nd'
    expect(computeReplaceRanges(content, 'b\nc', 'B\nX\nC', false)).toEqual([
      { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 4 },
    ])
  })

  it('替换为空：newEnd = newStart - 1（空新范围）', () => {
    const content = 'a\nb\nc'
    expect(computeReplaceRanges(content, 'b\n', '', false)).toEqual([
      { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 1 },
    ])
  })

  it('replaceAll：枚举全部匹配处；单处模式只取第一处', () => {
    const content = 'x\nmid\nx\nmid\nx'
    expect(computeReplaceRanges(content, 'mid', 'M', true)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 },
      { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 4 },
    ])
    expect(computeReplaceRanges(content, 'mid', 'M', false)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 },
    ])
  })

  it('重复文本：第二处行号在第一处替换后仍按原文行号计算（坐标描述原文位置）', () => {
    const content = '同文\n同文'
    expect(computeReplaceRanges(content, '同文', '新', true)).toEqual([
      { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 },
    ])
  })

  it('空文件填充：oldText 为空 → 旧范围空（1..0），新内容从第 1 行起', () => {
    expect(computeReplaceRanges('', '', '新内容\n两行', false)).toEqual([
      { oldStart: 1, oldEnd: 0, newStart: 1, newEnd: 2 },
    ])
  })

  it('找不到匹配返回空数组（防御；正常链路工具层已校验）', () => {
    expect(computeReplaceRanges('abc', 'zzz', 'x', false)).toEqual([])
  })
})
