import type { ModelProtocol } from '../../../types/ai'
import type { AgentAssistantResponse, AgentMessage, AgentToolSchema } from '../../agent/messages'

/**
 * 协议适配层的统一请求输入：中立消息词汇 + 协议无关参数。
 *
 * 各适配器负责把 AgentMessage 翻译成自家线格式（含 system/tool 消息的协议特有形态），
 * 并把线上的流式事件翻译回 ProtocolLlmEvent。历史消息里的 reasoning（思考流）
 * 只持久化展示用，适配器构造请求时一律丢弃——「只收不发」。
 */
export type ProtocolLlmInput = {
  baseUrl: string
  apiKey: string
  model: string
  messages: AgentMessage[]
  tools: AgentToolSchema[]
  /** 输出 token 上限；各协议映射自家字段（max_tokens / max_output_tokens / maxOutputTokens）。 */
  maxTokens?: number
  /** 外部停止信号（用户点击停止）。 */
  signal?: AbortSignal
}

/**
 * 协议中立的事件词汇。delta 为用户可见正文，reasoning-delta 为模型思考流
 * （DeepSeek reasoning_content / anthropic thinking / gemini thought）。
 */
export type ProtocolLlmEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'finish'; response: AgentAssistantResponse }
  | { type: 'error'; message: string }

/**
 * 一次模型调用的协议适配器。
 *
 * 契约（对齐 agent/llm.ts 既有语义，全部适配器一致遵守）：
 * - finishReason 归一为 'stop' | 'tool_calls' | 'length'，wire 原文进 diagnostics；
 * - 用户主动停止（input.signal abort）抛 AgentAbortedError，partialContent 只含正文；
 * - 请求失败先发 error 事件再抛错，两者消息一致；
 * - 流式空闲 90 秒超时（openai 适配器另带非流式 fallback，其余协议首版没有）。
 */
export type ProtocolAdapter = {
  readonly protocol: ModelProtocol
  stream(input: ProtocolLlmInput, onEvent: (event: ProtocolLlmEvent) => void): Promise<AgentAssistantResponse>
}

/** 用户主动停止运行时抛出的错误，用于区分超时与 fallback。 */
export class AgentAbortedError extends Error {
  readonly aborted = true
  readonly partialContent: string

  constructor(partialContent: string) {
    super('Agent 已被用户停止')
    this.name = 'AgentAbortedError'
    this.partialContent = partialContent
  }
}
