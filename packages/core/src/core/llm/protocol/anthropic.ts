import {
  appendProxyHeader,
  extractErrorMessage,
  normalizeBaseUrl,
  readJsonResponse,
  resolveApiUrl,
} from '../../ai/shared'
import { createAgentId } from '../../agent/messages'
import type {
  AgentAssistantResponse,
  AgentMessage,
  AgentToolCall,
} from '../../agent/messages'

import { consumeSseData, createRequestTimeout, isUserAbort, STREAM_IDLE_TIMEOUT_MS } from './sse'
import { AgentAbortedError } from './types'
import type { ProtocolAdapter, ProtocolLlmEvent, ProtocolLlmInput } from './types'

/** anthropic Messages API 要求 max_tokens 必填；未显式指定时的缺省上限。 */
const ANTHROPIC_MAX_TOKENS_DEFAULT = 8192

/**
 * 思考档位 → thinking.budget_tokens（思考强度计划 D2 映射表 anthropic 列，拍定值）：
 * anthropic 原生无档位概念，以预算数值表达强度；真 Anthropic 要求 max_tokens 严格大于
 * budget_tokens，超限时抬高 max_tokens（预算值不含正文空间）。
 */
const ANTHROPIC_THINKING_BUDGET: Record<'low' | 'high' | 'max', number> = {
  low: 2048,
  high: 8192,
  max: 16384,
}

/** 与 models-client 一致的稳定 API 版本。 */
const ANTHROPIC_VERSION = '2023-06-01'

type PendingToolUse = {
  id?: string
  name?: string
  jsonText: string
}

/**
 * Anthropic Messages 适配器（POST {base}/v1/messages，SSE 流式）。
 *
 * - system 提升为顶层 `system` 字段；assistant 工具调用映射 `tool_use` block，
 *   工具结果合并进紧随的 user 轮 `tool_result` block（anthropic 要求结果在 user 轮）；
 * - 流事件：text_delta → delta、thinking_delta → reasoning-delta、input_json_delta 累积工具参数；
 * - stop_reason 归一：end_turn/stop_sequence → stop、tool_use → tool_calls、max_tokens → length；
 * - 浏览器直连带 anthropic-dangerous-direct-browser-access；无非流式 fallback（首版不做）。
 */
export const anthropicAdapter: ProtocolAdapter = {
  protocol: 'anthropic',

  async stream(input: ProtocolLlmInput, onEvent: (event: ProtocolLlmEvent) => void): Promise<AgentAssistantResponse> {
    return streamAnthropic(input, onEvent)
  },
}

async function streamAnthropic(
  input: ProtocolLlmInput,
  onEvent: (event: ProtocolLlmEvent) => void,
): Promise<AgentAssistantResponse> {
  const baseUrl = stripTrailingV1(normalizeBaseUrl(input.baseUrl))

  if (input.signal?.aborted) {
    throw new AgentAbortedError('')
  }

  onEvent({ type: 'start' })

  const timeout = createRequestTimeout(STREAM_IDLE_TIMEOUT_MS, '流式响应空闲')
  const pendingToolUses = new Map<number, PendingToolUse>()
  let content = ''
  let reasoning = ''
  let thinkingSignature = ''
  let finishReason: string | undefined

  try {
    const response = await fetch(resolveApiUrl(baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: appendProxyHeader(
        {
          'Content-Type': 'application/json',
          'x-api-key': input.apiKey.trim(),
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        baseUrl,
      ),
      signal: timeout.signal,
      body: JSON.stringify(buildAnthropicRequestBody(input)),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      throw new Error(extractErrorMessage(payload, `Agent 调用模型失败（HTTP ${response.status}）`))
    }

    if (!response.body) {
      throw new Error('模型返回了空响应体')
    }

    await consumeSseData(response.body, {
      label: '流式响应空闲',
      timeoutSignal: timeout.signal,
      onChunk: () => timeout.reset(),
      userSignal: input.signal,
      onData: (data) => {
        let payload: unknown

        try {
          payload = JSON.parse(data)
        } catch {
          return
        }

        if (!isRecord(payload)) {
          return
        }

        switch (payload.type) {
          case 'content_block_start': {
            const block = payload.content_block
            if (isRecord(block) && block.type === 'tool_use') {
              pendingToolUses.set(readIndex(payload.index), {
                id: typeof block.id === 'string' ? block.id : undefined,
                name: typeof block.name === 'string' ? block.name : undefined,
                jsonText: '',
              })
            }
            break
          }
          case 'content_block_delta': {
            const delta = payload.delta

            if (!isRecord(delta)) {
              break
            }

            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              content += delta.text
              onEvent({ type: 'delta', text: delta.text })
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
              reasoning += delta.thinking
              onEvent({ type: 'reasoning-delta', text: delta.thinking })
            } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature) {
              // 思考块签名：真 Anthropic 思考模式回传 thinking block 时必须带原签名
              thinkingSignature += delta.signature
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const pending = pendingToolUses.get(readIndex(payload.index))

              if (pending) {
                pending.jsonText += delta.partial_json
              }
            }
            break
          }
          case 'message_delta': {
            const delta = payload.delta

            if (isRecord(delta) && typeof delta.stop_reason === 'string') {
              finishReason = mapStopReason(delta.stop_reason)
            }
            break
          }
          case 'error': {
            const error = payload.error
            const message = isRecord(error) && typeof error.message === 'string'
              ? error.message
              : '模型流式返回错误'
            throw new Error(message)
          }
          default:
            // message_start / content_block_stop / message_stop / ping 忽略
            break
        }
      },
    })
  } catch (error) {
    if (isUserAbort(error, input.signal)) {
      throw new AgentAbortedError(content)
    }

    const message = error instanceof Error ? error.message : String(error)
    onEvent({ type: 'error', message })
    throw error instanceof Error ? error : new Error(message)
  } finally {
    timeout.clear()
  }

  const toolCalls = finalizeToolUses(pendingToolUses)
  const result: AgentAssistantResponse = {
    content,
    toolCalls,
    finishReason: finishReason ?? 'stop',
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning && thinkingSignature ? { thinkingSignature } : {}),
  }

  onEvent({ type: 'finish', response: result })
  return result
}

function buildAnthropicRequestBody(input: ProtocolLlmInput) {
  const system = input.messages
    .filter((message): message is Extract<AgentMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const tools = input.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }))

  let maxTokens = input.maxTokens ?? ANTHROPIC_MAX_TOKENS_DEFAULT
  const thinking = resolveThinkingWire(input)

  if (thinking?.type === 'enabled' && maxTokens <= thinking.budget_tokens) {
    maxTokens = thinking.budget_tokens + 4096
  }

  return {
    model: input.model.trim(),
    max_tokens: maxTokens,
    stream: true,
    ...(system ? { system } : {}),
    messages: toAnthropicMessages(input.messages),
    ...(tools.length ? { tools } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

/**
 * 思考档位 → thinking 参数（思考强度计划 D2 映射表 anthropic 列）。
 * 缺省档不传（provider 自决）；off 显式关闭；low/high/max → enabled + 预算数值。
 */
function resolveThinkingWire(input: ProtocolLlmInput): { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } | undefined {
  const effort = input.reasoningEffort

  if (!effort) {
    return undefined
  }

  if (effort === 'off') {
    return { type: 'disabled' }
  }

  return { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] }
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

/**
 * 中立消息 → anthropic messages。
 * 工具结果必须出现在 user 轮的 tool_result block 里：连续的 tool 消息合并进同一个 user 轮
 * （Agent 循环的形态恒为 assistant(tool_use…) → tool… → …，合并只发生在工具批次处）。
 */
function toAnthropicMessages(messages: AgentMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      continue
    }

    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'text', text: message.content }] })
      continue
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []

      // 思考块回传：真 Anthropic 思考模式工具轮强制要求（signature 验签），
      // 必须位于 content 首位；DeepSeek anthropic 端点不校验，回传同样安全。缺签名则不带该字段。
      if (message.reasoning) {
        blocks.push({
          type: 'thinking',
          thinking: message.reasoning,
          ...(message.thinkingSignature ? { signature: message.thinkingSignature } : {}),
        })
      }

      if (message.content) {
        blocks.push({ type: 'text', text: message.content })
      }

      for (const toolCall of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })
      }

      // anthropic 拒绝空 content 数组；无任何块时补一个空文本块
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }

      result.push({ role: 'assistant', content: blocks })
      continue
    }

    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content,
    }
    const last = result[result.length - 1]

    if (last && last.role === 'user' && last.content[0]?.type === 'tool_result') {
      last.content.push(block)
    } else {
      result.push({ role: 'user', content: [block] })
    }
  }

  return result
}

function mapStopReason(stopReason: string): string {
  if (stopReason === 'tool_use') {
    return 'tool_calls'
  }

  if (stopReason === 'max_tokens') {
    return 'length'
  }

  // end_turn / stop_sequence / refusal 及未知值
  return 'stop'
}

function finalizeToolUses(pendingToolUses: Map<number, PendingToolUse>): AgentToolCall[] {
  return Array.from(pendingToolUses.entries())
    .sort(([left], [right]) => left - right)
    .map(([, value]) => ({
      id: value.id || createAgentId('tool_call'),
      name: value.name as AgentToolCall['name'],
      input: parseToolInput(value.jsonText),
    }))
    .filter((toolCall) => Boolean(toolCall.name))
}

function parseToolInput(jsonText: string): Record<string, unknown> {
  if (!jsonText.trim()) {
    return {}
  }

  try {
    const value = JSON.parse(jsonText)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function readIndex(value: unknown): number {
  return typeof value === 'number' ? value : -1
}

/** 兼容 https://api.anthropic.com 与 …/v1 两种 baseUrl 写法（与 models-client 同款归一）。 */
function stripTrailingV1(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? baseUrl.slice(0, -'/v1'.length) : baseUrl
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
