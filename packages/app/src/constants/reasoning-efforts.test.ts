import { describe, expect, it } from 'vitest'

import {
  REASONING_EFFORT_OPTIONS,
  reasoningEffortLabel,
  reasoningEffortOptions,
} from './reasoning-efforts'

describe('思考档位表（思考强度计划 D3；default 档已移除，未配置 = 关闭）', () => {
  it('四档全集：值与标签一一对应，off 打头（未配置即按它显示）', () => {
    expect(REASONING_EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      'low',
      'high',
      'max',
    ])
  })

  it('openai + DeepSeek 方言：四档全显示（thinking 开关与三档 effort 全支持）', () => {
    const options = reasoningEffortOptions('openai', 'https://api.deepseek.com/v1')
    expect(options.map((option) => option.value)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('openai + 其他后端：隐藏 off（OpenAI 官方语义无关闭思考参数）', () => {
    const options = reasoningEffortOptions('openai', 'https://api.siliconflow.cn/v1')
    expect(options.map((option) => option.value)).toEqual(['low', 'high', 'max'])
  })

  it('openai-responses：隐藏 off；anthropic / gemini：四档全显示', () => {
    expect(reasoningEffortOptions('openai-responses', 'https://api.openai.com/v1')
      .map((option) => option.value)).toEqual(['low', 'high', 'max'])
    expect(reasoningEffortOptions('anthropic', 'https://api.anthropic.com')
      .map((option) => option.value)).toEqual(['off', 'low', 'high', 'max'])
    expect(reasoningEffortOptions('gemini', 'https://generativelanguage.googleapis.com')
      .map((option) => option.value)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('档位显示名：已知值查表，未知/缺省回退「关闭」', () => {
    expect(reasoningEffortLabel('max')).toBe('最高')
    expect(reasoningEffortLabel('off')).toBe('关闭')
    expect(reasoningEffortLabel(undefined)).toBe('关闭')
    expect(reasoningEffortLabel('bogus' as never)).toBe('关闭')
  })
})
