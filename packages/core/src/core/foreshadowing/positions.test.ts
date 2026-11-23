import { describe, expect, it } from 'vitest'

import {
  OPEN_END_PLACEHOLDER,
  deriveLegacyPayoffWindow,
  derivePositionsFromLegacyWindow,
  effectivePlannedWindow,
  formatPlannedPosition,
  parsePlannedPosition,
  payoffWindowMismatch,
  plannedPositionTarget,
  validatePlannedWindow,
} from './positions'
import { ForeshadowingError } from '../../types/foreshadowing'
import type { PlannedPosition, PlannedWindowEnd } from '../../types/foreshadowing'

describe('计划位置编解码', () => {
  it('各形态往返无损；字段缺失返回 null（= 无结构化数据）', () => {
    expect(parsePlannedPosition(undefined)).toBeNull()
    expect(parsePlannedPosition('')).toBeNull()
    expect(parsePlannedPosition('  ')).toBeNull()

    const cases: Array<PlannedPosition | PlannedWindowEnd> = [
      { kind: 'none' },
      { kind: 'open' },
      { kind: 'chapter', ref: '第一卷/第012章-夜行' },
      { kind: 'future', target: 15 },
      { kind: 'relative', target: 15, base: 12, offset: 3 },
    ]
    for (const position of cases) {
      expect(parsePlannedPosition(formatPlannedPosition(position))).toEqual(position)
    }
  })

  it('无法识别的值保留原文（raw），往返不丢外部写入', () => {
    expect(parsePlannedPosition('大概第十几章')).toEqual({ kind: 'raw', raw: '大概第十几章' })
    expect(formatPlannedPosition({ kind: 'raw', raw: '大概第十几章' })).toBe('大概第十几章')

    // 目标 ≠ 基准 + 偏移的相对位置：按 raw 保留，不静默修正
    expect(parsePlannedPosition('relative:15:12:2')).toEqual({ kind: 'raw', raw: 'relative:15:12:2' })
    expect(parsePlannedPosition('future:0')).toEqual({ kind: 'raw', raw: 'future:0' })
    expect(parsePlannedPosition('chapter:')).toEqual({ kind: 'raw', raw: 'chapter:' })
  })

  it('目标章号解析：未来/相对取保存目标；章节按「第N章」解析；其余 null', () => {
    expect(plannedPositionTarget({ kind: 'future', target: 15 })).toBe(15)
    expect(plannedPositionTarget({ kind: 'relative', target: 15, base: 12, offset: 3 })).toBe(15)
    expect(plannedPositionTarget({ kind: 'chapter', ref: '第一卷/第012章-夜行' })).toBe(12)
    expect(plannedPositionTarget({ kind: 'chapter', ref: '没有章号' })).toBeNull()
    expect(plannedPositionTarget({ kind: 'none' })).toBeNull()
    expect(plannedPositionTarget({ kind: 'open' })).toBeNull()
    expect(plannedPositionTarget({ kind: 'raw', raw: 'x' })).toBeNull()
  })
})

describe('旧窗口派生', () => {
  it('结构化 → 可读旧字段：确定位置写起止标识；开放终点/无终点写占位；未设置保持 null', () => {
    expect(deriveLegacyPayoffWindow(
      { kind: 'chapter', ref: '第一卷/第010章-启程' },
      { kind: 'chapter', ref: '第一卷/第020章-风起' },
    )).toEqual(['第一卷/第010章-启程', '第一卷/第020章-风起'])

    expect(deriveLegacyPayoffWindow(
      { kind: 'chapter', ref: '第一卷/第010章-启程' },
      { kind: 'open' },
    )).toEqual(['第一卷/第010章-启程', OPEN_END_PLACEHOLDER])

    expect(deriveLegacyPayoffWindow({ kind: 'future', target: 30 }, { kind: 'future', target: 45 }))
      .toEqual(['第30章', '第45章'])

    expect(deriveLegacyPayoffWindow({ kind: 'relative', target: 15, base: 12, offset: 3 }, { kind: 'open' }))
      .toEqual(['第15章', OPEN_END_PLACEHOLDER])

    expect(deriveLegacyPayoffWindow({ kind: 'none' }, { kind: 'none' })).toBeNull()
  })

  it('旧窗口 → 结构化：端点成章节引用；占位与空终点解释为开放终点；空窗口未设置', () => {
    expect(derivePositionsFromLegacyWindow(null)).toEqual({
      start: { kind: 'none' },
      end: { kind: 'none' },
    })

    expect(derivePositionsFromLegacyWindow(['第一卷/第010章-启程', '第020章'])).toEqual({
      start: { kind: 'chapter', ref: '第一卷/第010章-启程' },
      end: { kind: 'chapter', ref: '第020章' },
    })

    expect(derivePositionsFromLegacyWindow(['第010章', OPEN_END_PLACEHOLDER])).toEqual({
      start: { kind: 'chapter', ref: '第010章' },
      end: { kind: 'open' },
    })

    expect(derivePositionsFromLegacyWindow(['第010章', ''])).toEqual({
      start: { kind: 'chapter', ref: '第010章' },
      end: { kind: 'open' },
    })

    expect(derivePositionsFromLegacyWindow(['', ''])).toEqual({
      start: { kind: 'none' },
      end: { kind: 'none' },
    })
  })

  it('有效窗口：结构化存在时以它为准（缺失端补未设置）；旧卡按旧窗口反向推导', () => {
    expect(effectivePlannedWindow({
      payoffStart: { kind: 'future', target: 15 },
      payoffEnd: null,
      payoffWindow: ['第010章', '第012章'],
    })).toEqual({
      start: { kind: 'future', target: 15 },
      end: { kind: 'none' },
    })

    expect(effectivePlannedWindow({
      payoffStart: null,
      payoffEnd: null,
      payoffWindow: ['第010章', OPEN_END_PLACEHOLDER],
    })).toEqual({
      start: { kind: 'chapter', ref: '第010章' },
      end: { kind: 'open' },
    })
  })

  it('新旧不一致检测：仅结构化存在时比较派生旧字段与磁盘旧字段', () => {
    expect(payoffWindowMismatch({
      payoffStart: { kind: 'future', target: 15 },
      payoffEnd: { kind: 'open' },
      payoffWindow: ['第015章', OPEN_END_PLACEHOLDER],
    })).toBe(false)

    expect(payoffWindowMismatch({
      payoffStart: { kind: 'future', target: 15 },
      payoffEnd: { kind: 'open' },
      payoffWindow: ['第020章', OPEN_END_PLACEHOLDER],
    })).toBe(true)

    // 旧卡（无结构化数据）永远不算不一致
    expect(payoffWindowMismatch({
      payoffStart: null,
      payoffEnd: null,
      payoffWindow: ['第020章', OPEN_END_PLACEHOLDER],
    })).toBe(false)
  })
})

describe('窗口校验', () => {
  it('相对位置非法（非正整数基准/偏移或目标不符）拒绝', () => {
    expect(() => validatePlannedWindow(
      { kind: 'relative', target: 14, base: 12, offset: 3 },
      { kind: 'open' },
    )).toThrow(ForeshadowingError)
    expect(() => validatePlannedWindow(
      { kind: 'relative', target: 12, base: 0, offset: 12 },
      { kind: 'open' },
    )).toThrow(/正整数/)
  })

  it('起点未设置时终点不能有值（先补起点）', () => {
    expect(() => validatePlannedWindow(
      { kind: 'none' },
      { kind: 'future', target: 15 },
    )).toThrow(/先补起点|起点/)
    expect(() => validatePlannedWindow(
      { kind: 'none' },
      { kind: 'open' },
    )).toThrow(/先补起点|起点/)
  })

  it('起点晚于终点拒绝（不写入倒置窗口）；相等与开放终点合法', () => {
    expect(() => validatePlannedWindow(
      { kind: 'future', target: 20 },
      { kind: 'future', target: 15 },
    )).toThrow(/晚于终点/)

    expect(() => validatePlannedWindow(
      { kind: 'future', target: 15 },
      { kind: 'future', target: 15 },
    )).not.toThrow()

    expect(() => validatePlannedWindow(
      { kind: 'chapter', ref: '第一卷/第010章-x' },
      { kind: 'open' },
    )).not.toThrow()
  })
})
