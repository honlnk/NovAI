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

/**
 * 思考强度档位（配置层五档，输入框选择器与 config.llm.reasoningEffort 共用）。
 *
 * - `default`：不传任何思考参数（provider 自决；DeepSeek 即默认思考开）——即请求层字段缺省；
 * - `off`：显式关闭思考；
 * - `low` / `high` / `max`：三档强度（DeepSeek 全集；其他协议的 wire 映射与降级见各适配器）。
 */
export type ReasoningEffort = 'default' | 'off' | 'low' | 'high' | 'max'

/** 请求层思考档位：default 不上请求（字段缺省即 default），其余四档随 AgentLlmInput 下发。 */
export type AgentReasoningEffort = Exclude<ReasoningEffort, 'default'>

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
