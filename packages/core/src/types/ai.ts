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
 * 思考强度档位（配置层四档，输入框选择器与 config.llm.reasoningEffort 共用）。
 *
 * - `off`：关闭思考（配置缺省也按它解析——默认关闭，2026-09-24 拍板，对齐 dsh 无「默认」档的形态）；
 * - `low` / `high` / `max`：三档强度（DeepSeek 全集；其他协议的 wire 映射与降级见各适配器）。
 *
 * 曾有的 `default` 档（不传参数、provider 自决）已移除：dsh 的 DeepSeek 单适配兜底 high、
 * 多供应商 pi-ai 适配兜底省略，两者都依赖模型能力表；NovAI 无能力表，跨协议兜底 off 最稳。
 */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

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
