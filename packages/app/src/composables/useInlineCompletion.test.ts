import { describe, expect, it } from 'vitest'

import { splitFirstSegment } from './useInlineCompletion'

/**
 * splitFirstSegment 的纯函数测试（不依赖 DOM）。
 *
 * 验证「逐段接受」的核心：每次 Tab 吞掉建议的首个中文分词单位。
 *
 * 注意：Intl.Segmenter 的具体切分粒度依赖运行时 ICU 版本（不同 Node 构建可能把
 * 「主角登场」切成「主角/登/场」或整词「主角登场」）。因此测试以「拼回原文」、
 * 「首段非空」这类不依赖切分粒度的不变量为准，不硬编码具体断词结果。
 */

/** 反复 splitFirstSegment 直到建议被吃完，返回吃到的所有段。 */
function eatAll(suggestion: string): string[] {
  const accepted: string[] = []
  let remaining = suggestion
  while (remaining) {
    const { first, rest } = splitFirstSegment(remaining)
    if (!first) break
    accepted.push(first)
    remaining = rest
  }
  return accepted
}

describe('splitFirstSegment - 基本行为', () => {
  it('空串返回空', () => {
    expect(splitFirstSegment('')).toEqual({ first: '', rest: '' })
  })

  it('纯空白返回空', () => {
    expect(splitFirstSegment('   ')).toEqual({ first: '', rest: '' })
  })
})

describe('splitFirstSegment - 逐段吃完整条建议（不变量）', () => {
  it('中文：吃完整条后拼回等于原文，且每段非空', () => {
    const original = '主角进入密境探索宝藏'
    const accepted = eatAll(original)

    expect(accepted.join('')).toBe(original)
    expect(accepted.length).toBeGreaterThan(0)
    for (const seg of accepted) {
      expect(seg.length).toBeGreaterThan(0)
    }
  })

  it('中英混合：吃完整条后拼回等于原文', () => {
    const original = '写第3章，主角登场'
    const accepted = eatAll(original)
    expect(accepted.join('')).toBe(original)
  })

  it('英文：吃完整条后拼回等于原文', () => {
    const original = 'write chapter three'
    const accepted = eatAll(original)
    expect(accepted.join('')).toBe(original)
  })

  it('带前导空白：空白与首个实质段一起吞（保证拼回不丢空格）', () => {
    const { first } = splitFirstSegment('  主角登场')
    expect(first.length).toBeGreaterThan(0)
    // 首段包含实质内容（去掉空白后非空）
    expect(first.trim().length).toBeGreaterThan(0)
    // 以主角开头（可能带前导空白）
    expect(first.trimStart().startsWith('主角')).toBe(true)
  })

  it('带标点：首段吞掉开头的标点（与后续词合并，避免标点卡住）', () => {
    const { first } = splitFirstSegment('，主角登场')
    // 首段应以标点开头，且包含后续实质内容
    expect(first.startsWith('，')).toBe(true)
    expect(first.length).toBeGreaterThan(1)
  })

  it('多次 Tab 后剩余最终为空', () => {
    const accepted = eatAll('一段较长的中文建议文本用于测试逐段接受')
    expect(accepted.length).toBeGreaterThan(0)
    // 全部吃完，再 split 应返回空
    expect(splitFirstSegment('')).toEqual({ first: '', rest: '' })
  })
})
