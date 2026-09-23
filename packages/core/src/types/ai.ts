export type ModelKind = 'llm' | 'embedding'

/**
 * 模型服务的 API 协议。
 *
 * OpenAI 有两套协议：`openai`（Chat Completions，`/chat/completions`）与
 * `openai-responses`（Responses API，`/responses`，o 系列 / gpt-5 系列主推）。
 *
 * 四种协议的生成链路（Agent Loop / 流式 tool_calls / 思考流）均已接入
 * （core/llm/protocol/ 适配器按协议分发）；anthropic / gemini 真机待 key 复核。
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
  /** API 协议，缺省 openai；随生成链路分发到对应适配器。 */
  protocol?: ModelProtocol
  systemPrompt?: string
  instruction: string
}
