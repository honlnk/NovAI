import { describe, expect, it } from 'vitest'

import {
  modeFromEncoded,
  pickerModes,
  relativeSummary,
  validateFutureInput,
  validateRelativeInput,
} from './planned-position-picker-state'

describe('计划位置选择器模式集合', () => {
  it('起点含「未设置」，终点含「开放终点」；都不出现对方的收尾模式', () => {
    const startModes = pickerModes(false).map((item) => item.value)
    const endModes = pickerModes(true).map((item) => item.value)

    expect(startModes).toEqual(['none', 'chapter', 'relative', 'future'])
    expect(endModes).toEqual(['chapter', 'relative', 'future', 'open'])
  })

  it('编码值推断模式：空串/未知按未设置，raw 独立成模式', () => {
    expect(modeFromEncoded('')).toBe('none')
    expect(modeFromEncoded('none')).toBe('none')
    expect(modeFromEncoded('open')).toBe('open')
    expect(modeFromEncoded('chapter:第一卷/第012章')).toBe('chapter')
    expect(modeFromEncoded('future:15')).toBe('future')
    expect(modeFromEncoded('relative:15:12:3')).toBe('relative')
    expect(modeFromEncoded('大概第十几章')).toBe('raw')
  })
})

describe('相对位置输入校验', () => {
  it('基准与偏移都须正整数；目标 = 基准 + 偏移', () => {
    expect(validateRelativeInput(12, 3)).toEqual({ ok: true, target: 15 })
    expect(validateRelativeInput(null, 3)).toEqual({ ok: false, message: '基准章号须为正整数' })
    expect(validateRelativeInput(0, 3)).toEqual({ ok: false, message: '基准章号须为正整数' })
    expect(validateRelativeInput(12, 0)).toEqual({ ok: false, message: '偏移量须为正整数（至少 1 章）' })
    expect(validateRelativeInput(12, null).ok).toBe(false)
    expect(validateRelativeInput(1.5, 3).ok).toBe(false)
  })

  it('展示文本带基准、偏移与确定目标（保存后不漂移的提示）', () => {
    expect(relativeSummary(12, 3)).toBe('第12章之后 3 章 → 第15章（基准已固定）')
    expect(relativeSummary(null, 3)).toBe('待补基准章号与偏移量')
  })
})

describe('未来章号输入校验', () => {
  it('正整数即可（允许编号空隙中未创建的章号）', () => {
    expect(validateFutureInput(15)).toEqual({ ok: true, target: 15 })
    expect(validateFutureInput(null)).toEqual({ ok: false, message: '章号须为正整数' })
    expect(validateFutureInput(0).ok).toBe(false)
    expect(validateFutureInput(2.5).ok).toBe(false)
  })
})
