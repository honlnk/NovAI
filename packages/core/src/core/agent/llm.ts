import { normalizeBaseUrl } from '../ai/shared'
import { resolveProtocolAdapter } from '../llm/protocol/resolve'
import { AgentAbortedError } from '../llm/protocol/types'
import type { ProtocolLlmEvent } from '../llm/protocol/types'
import type { ModelProtocol, AgentReasoningEffort } from '../../types/ai'

import type {
  AgentAssistantResponse,
  AgentMessage,
  AgentToolSchema,
} from './messages'

export type AgentLlmInput = {
  baseUrl: string
  apiKey: string
  model: string
  /** API 协议，缺省 openai（Chat Completions 兼容）。分发到 core/llm/protocol 下的适配器。 */
  protocol?: ModelProtocol
  messages: AgentMessage[]
  tools: AgentToolSchema[]
  /** 输出 token 上限（映射 OpenAI max_tokens）。缺省不传，由 provider 默认。压缩摘要调用必须传。 */
  maxTokens?: number
  /**
   * 思考强度档位（缺省不传 = default，provider 自决）。各适配器映射到协议 wire 参数；
   * 压缩摘要 / 要素提取等辅助请求固定传 'off'（省 token，对齐 dsh 对辅助调用的处理）。
   */
  reasoningEffort?: AgentReasoningEffort
  /** 外部停止信号（用户点击停止）。一旦 abort，立即中断流式，且不触发非流式 fallback。 */
  signal?: AbortSignal
}

export type AgentLlmEvent = ProtocolLlmEvent

export { AgentAbortedError }

/**
 * Agent 循环的模型调用入口：协议无关的参数校验后，按 protocol 分发到对应适配器。
 * 各协议的线格式差异（端点、鉴权头、消息与工具的线形态、流式事件）全部收在适配器内。
 */
export async function streamAgentCompletion(
  input: AgentLlmInput,
  onEvent: (event: AgentLlmEvent) => void,
): Promise<AgentAssistantResponse> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model.trim()) {
    const message = '请先填写 LLM 的 API 地址、API Key 和模型名称'
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  // 用户在请求开始前就已经点了停止 —— 直接中止
  if (input.signal?.aborted) {
    throw new AgentAbortedError('')
  }

  const adapter = resolveProtocolAdapter(input.protocol ?? 'openai')
  return adapter.stream(input, onEvent)
}
