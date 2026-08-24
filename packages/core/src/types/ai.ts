export type ModelKind = 'llm' | 'embedding'

/**
 * 模型服务的 API 协议。
 *
 * OpenAI 有两套协议：`openai`（Chat Completions，`/chat/completions`）与
 * `openai-responses`（Responses API，`/responses`，o 系列 / gpt-5 系列主推）。
 *
 * 当前生成链路（Agent Loop / 流式 tool_calls）只实现 openai 兼容协议；
 * 其余协议仅在配置层（协议选择、拉取模型列表、测试连接）支持。
 */
export type ModelProtocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini'

export type ModelConnectionInput = {
  baseUrl: string
  apiKey: string
  model?: string
  protocol?: ModelProtocol
  kind: ModelKind
}

export type ModelConnectionResult = {
  ok: boolean
  message: string
}

export type LlmStreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; text: string }
  | { type: 'error'; message: string }

export type LlmStreamInput = {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt?: string
  instruction: string
}
