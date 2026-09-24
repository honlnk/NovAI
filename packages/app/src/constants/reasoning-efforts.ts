import type { ReasoningEffort } from '@novai/core/types/ai'

import { isDeepSeekDialect } from '@novai/core/services/types'

/**
 * 思考强度四档（与 core types/ai.ts 的 ReasoningEffort 一一对应）。
 * 输入区思考档位选择器使用这一份定义；wire 映射在各协议适配器（思考强度计划 D2 映射表）。
 * 未配置 = 关闭（'default' 档已移除，2026-09-24 拍板，对齐 dsh 无「默认」档的形态）。
 */
export const REASONING_EFFORT_OPTIONS = [
  { value: 'off', label: '关闭', hint: '显式关闭思考，更快更省 token（未配置时的默认档）' },
  { value: 'low', label: '低', hint: '轻度思考，速度与深度的平衡' },
  { value: 'high', label: '高', hint: '深度思考，适合复杂情节推演与长线伏笔' },
  { value: 'max', label: '最高', hint: '最大思考预算，难题攻坚' },
] as const satisfies ReadonlyArray<{ value: ReasoningEffort; label: string; hint: string }>

export const FALLBACK_REASONING_EFFORT_LABEL = '关闭'

/** 档位显示名；未知/缺省值回退「关闭」（未配置 = 默认关闭）。 */
export function reasoningEffortLabel(effort: ReasoningEffort | undefined): string {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === effort)?.label
    ?? FALLBACK_REASONING_EFFORT_LABEL
}

/**
 * 按协议 × 方言过滤可选档位（思考强度计划 D3）：
 * OpenAI 官方语义（非 DeepSeek 方言的 openai 与 openai-responses）没有关闭思考的参数，
 * off 档无法实现——不显示骗人的档。max 在这两处的降级（映射为 high）由适配器承担。
 */
export function reasoningEffortOptions(
  protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini',
  baseUrl: string,
) {
  const hideOff = protocol === 'openai-responses' || (protocol === 'openai' && !isDeepSeekDialect(baseUrl))

  return hideOff
    ? REASONING_EFFORT_OPTIONS.filter((option) => option.value !== 'off')
    : [...REASONING_EFFORT_OPTIONS]
}
