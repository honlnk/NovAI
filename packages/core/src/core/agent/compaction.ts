import { streamAgentCompletion, AgentAbortedError } from './llm'
import type { AgentAssistantResponse } from './messages'
import type { AgentMessage, AgentUserMessage } from './messages'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateTokens,
  replaceRangeWithSummary,
  type ModelView,
} from './model-view'
import type { ProjectConfig } from '../../types/project'

/**
 * 上下文压缩（compaction）：照抄 dsh 的算法语义，存储用 ModelView 的区间替换。
 *
 * - 触发：请求前压力检查（token 阈值）+ provider 报 context-overflow 时强制压一次重试；
 * - 选区：system 提示永不进压缩区；尾部保留 retainTokens；工具配对回退保证切线
 *   不切开 assistant(toolCalls) ↔ tool 结果；
 * - 摘要：KV-cache 友好（系统提示 + 被压区间 + 末尾压缩指令），固定八节 Markdown 检查点，
 *   空输出/截断/不收缩一律不落地（宁缺毋滥）。
 */

export const COMPACTED_SUMMARY_OPEN = '<compacted-summary>'
export const COMPACTED_SUMMARY_CLOSE = '</compacted-summary>'

/** 尾部保留比例（dsh：contextWindow × 16% 的原文永不进摘要）。 */
export const RETAIN_TOKEN_RATIO = 0.16

/** 摘要调用的输出 token 上限（dsh compaction 默认 8192）。配合 finishReason==='length' 拒落地构成安全阀。 */
export const SUMMARY_MAX_TOKENS = 8192

/** 是否达到压缩阈值（压力触发）。 */
export function shouldCompact(view: ModelView, thresholdTokens: number): boolean {
  return estimateTokens(view) >= thresholdTokens
}

/**
 * 计算压缩时尾部应保留的 token 量：按阈值比例与按轮数口径取并集——
 * 既保留阈值 × 16% 的 token，也至少保留最近 keepRecentTurns 轮（以 user 消息为轮次边界）的原文。
 */
export function computeRetainTokens(
  messages: AgentMessage[],
  thresholdTokens: number,
  keepRecentTurns: number,
): number {
  const byRatio = Math.floor(thresholdTokens * RETAIN_TOKEN_RATIO)
  if (keepRecentTurns <= 0) {
    return byRatio
  }

  let userCount = 0
  let boundary = messages.length
  while (boundary > 1) {
    boundary -= 1
    if (messages[boundary].role === 'user') {
      userCount += 1
      if (userCount >= keepRecentTurns) {
        break
      }
    }
  }

  const byTurns = boundary > 1 ? estimateMessagesTokens(messages.slice(boundary)) : 0
  return Math.max(byRatio, byTurns)
}

/**
 * 选出本次压缩的区间 [startIdx, endIdx]（含两端）；无可压区间时返回 null。
 *
 * - startIdx 恒为 1：system 提示（messages[0]）永不进压缩区；
 * - 从尾部向前累加 token 直到 retainTokens，其前的连续区间即压缩区；
 * - 工具配对回退：若保留区起点是 tool 结果（其配对 call 落在压缩区），边界向前移
 *   直到切线平衡——绝不让模型看到悬空的 tool result。
 */
export function selectCompactionRange(
  view: ModelView,
  retainTokens: number,
): { startIdx: number; endIdx: number } | null {
  const messages = view.messages

  // system 不在 index 0（异常视图）或除 system 外不足一条时无可压区间
  if (messages.length <= 2 || messages[0].role !== 'system') {
    return null
  }

  let acc = 0
  let boundary = messages.length
  while (boundary - 1 >= 1 && acc < retainTokens) {
    boundary -= 1
    acc += estimateMessagesTokens([messages[boundary]])
  }

  let endIdx = boundary - 1
  // 工具配对回退：保留区第一条消息若是 tool 结果，其配对 call 在压缩区，边界前移
  while (endIdx >= 1 && messages[endIdx + 1]?.role === 'tool') {
    endIdx -= 1
  }

  if (endIdx < 1) {
    return null
  }

  return { startIdx: 1, endIdx }
}

/**
 * 构建摘要调用的请求消息：系统提示 + 被压区间原文 + 末尾一条 user 压缩指令。
 * 整段前缀与上次真实请求一致（KV-cache / prefix cache 友好）。
 */
export function buildCompactionRequest(
  view: ModelView,
  range: { startIdx: number; endIdx: number },
): AgentMessage[] {
  return [
    ...view.messages.slice(0, 1),
    ...view.messages.slice(range.startIdx, range.endIdx + 1),
    { role: 'user', content: COMPACTION_INSTRUCTION },
  ]
}

/**
 * 摘要校验（安全阀）：非空 + 严格收缩（摘要 token 必须小于被压区间 token）。
 * 截断（finishReason === 'length'）由调用处结合响应判断，两者任一不满足都不落地。
 */
export function validateSummary(summary: string, originalTokens: number): boolean {
  const trimmed = summary.trim()
  if (!trimmed) {
    return false
  }
  return estimateTextTokens(trimmed) < originalTokens
}

/** 落地回注的摘要消息：preamble + <compacted-summary> 包裹（user 角色）。 */
export function buildSummaryMessage(summary: string): AgentUserMessage {
  return {
    role: 'user',
    content: [
      '以下是本对话此前进展的检查点摘要。请把它当作既定背景直接继续当前任务，不要回应、复述或总结此检查点。',
      COMPACTED_SUMMARY_OPEN,
      summary.trim(),
      COMPACTED_SUMMARY_CLOSE,
    ].join('\n'),
  }
}

/** 判定错误是否为 context 超限类错误（溢出触发的依据）。 */
export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const text = error.message.toLowerCase()
  return (
    text.includes('context_length_exceeded')
    || text.includes('maximum context length')
    || (text.includes('context') && (text.includes('length') || text.includes('window') || text.includes('exceed')))
    // 百炼（DashScope）："Range of input length should be [1, xxx]"（400 InvalidParameter），不含 context 字样
    || text.includes('range of input length')
    || (text.includes('input length') && (text.includes('exceed') || text.includes('should be') || text.includes('too long')))
  )
}

export type CompactionResult = {
  /** 被压区间包含的消息条数 */
  compactedMessageCount: number
  /** 被压区间的 token 估算 */
  originalTokens: number
  /** 摘要的 token 估算 */
  summaryTokens: number
}

/**
 * 执行一次压缩：选区 → 摘要调用（无 tools） → 校验 → 区间替换。
 * 任一步失败（无可压区间/摘要为空/截断/不收缩/调用出错）返回 null，不改动视图（宁缺毋滥）。
 * 用户主动停止（AgentAbortedError）向上传播，由 query 循环的 abort 处理接管。
 */
export async function runCompaction(input: {
  config: ProjectConfig
  view: ModelView
  retainTokens: number
  signal?: AbortSignal
}): Promise<CompactionResult | null> {
  const range = selectCompactionRange(input.view, input.retainTokens)
  if (!range) {
    return null
  }

  const originalMessages = input.view.messages.slice(range.startIdx, range.endIdx + 1)
  const originalTokens = estimateMessagesTokens(originalMessages)
  if (originalTokens <= 0) {
    return null
  }

  let response: AgentAssistantResponse
  try {
    response = await streamAgentCompletion(
      {
        baseUrl: input.config.llm.baseUrl,
        apiKey: input.config.llm.apiKey,
        model: input.config.llm.model,
        protocol: input.config.llm.protocol,
        messages: buildCompactionRequest(input.view, range),
        tools: [],
        maxTokens: SUMMARY_MAX_TOKENS,
        signal: input.signal,
      },
      () => {},
    )
  } catch (error) {
    if (error instanceof AgentAbortedError) {
      throw error
    }
    return null
  }

  const summary = response.content.trim()
  // 安全阀：空输出或被 max-tokens 截断视为失败，不落地
  if (!summary || response.finishReason === 'length' || !validateSummary(summary, originalTokens)) {
    return null
  }

  replaceRangeWithSummary(input.view, range.startIdx, range.endIdx, buildSummaryMessage(summary))

  return {
    compactedMessageCount: originalMessages.length,
    originalTokens,
    summaryTokens: estimateTextTokens(summary),
  }
}

/** 压缩指令：固定八节 Markdown 检查点（照搬 dsh 模板），含 <compacted-summary> 自合并规则。 */
export const COMPACTION_INSTRUCTION = `请把上面这段对话历史压缩成一份结构化的检查点摘要，供后续对话作为上下文继续任务。要求：

- 只输出检查点本体（Markdown），不要任何开场白、解释或结语，也不要提及这是一个压缩请求。
- 使用以下固定八节结构，节标题照抄原文，没有内容的节写 (none)：

## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context

- 保留精确的文件路径、章节号、人物名、地点、伏笔与用户做出的纠正，它们比修辞重要。
- 若输入中已有 ${COMPACTED_SUMMARY_OPEN} 块（旧检查点），不要照抄：把其中仍然为真的事实合并进对应小节，产出单一整合后的总结，使多轮压缩收敛。
- 摘要必须显著短于原文，聚焦后续任务需要的信息，删除客套与重复。`
