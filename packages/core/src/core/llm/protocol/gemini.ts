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

/**
 * Gemini generateContent 适配器（POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse）。
 *
 * - system 提升为 `systemInstruction`；assistant 文本/工具调用映射 model 轮
 *   `{text}` / `{functionCall}` parts；工具结果映射 user 轮 `{functionResponse}` parts
 *   （连续结果合并进同一 user 轮）；
 * - parts 里 `thought: true` 的文本是思考流 → reasoning-delta；`finishReason` 归一：
 *   STOP→stop、MAX_TOKENS→length、安全类（SAFETY/RECITATION 等）→ 抛错（模型被中止）；
 * - functionCall part 的 `thoughtSignature` 存进 AgentToolCall 附加字段并在后续请求
 *   原样回传（Gemini 2.5 思考模型函数调用的强校验要求）；
 * - 工具 schema 剥离 gemini 不认识的字段（additionalProperties/$schema，逐层递归）；
 * - 鉴权走 x-goog-api-key；无真机（mock wire 测试兜底，待有 key 后复核）。
 */
export const geminiAdapter: ProtocolAdapter = {
  protocol: 'gemini',

  async stream(input: ProtocolLlmInput, onEvent: (event: ProtocolLlmEvent) => void): Promise<AgentAssistantResponse> {
    return streamGemini(input, onEvent)
  },
}

async function streamGemini(
  input: ProtocolLlmInput,
  onEvent: (event: ProtocolLlmEvent) => void,
): Promise<AgentAssistantResponse> {
  const baseUrl = stripTrailingVersionSegments(normalizeBaseUrl(input.baseUrl))
  const model = input.model.trim().replace(/^models\//, '')

  if (input.signal?.aborted) {
    throw new AgentAbortedError('')
  }

  onEvent({ type: 'start' })

  const timeout = createRequestTimeout(STREAM_IDLE_TIMEOUT_MS, '流式响应空闲')
  const toolCalls: AgentToolCall[] = []
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let safetyStopReason: string | undefined

  try {
    const response = await fetch(
      `${resolveApiUrl(baseUrl, `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`)}?alt=sse`,
      {
        method: 'POST',
        headers: appendProxyHeader(
          {
            'Content-Type': 'application/json',
            'x-goog-api-key': input.apiKey.trim(),
          },
          baseUrl,
        ),
        signal: timeout.signal,
        body: JSON.stringify(buildGeminiRequestBody(input)),
      },
    )

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

        const candidate = Array.isArray(payload.candidates) && isRecord(payload.candidates[0])
          ? payload.candidates[0]
          : undefined

        if (!candidate) {
          return
        }

        const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts)
          ? candidate.content.parts
          : []

        for (const rawPart of parts) {
          if (!isRecord(rawPart)) {
            continue
          }

          if (typeof rawPart.text === 'string' && rawPart.text) {
            if (rawPart.thought === true) {
              reasoning += rawPart.text
              onEvent({ type: 'reasoning-delta', text: rawPart.text })
            } else {
              content += rawPart.text
              onEvent({ type: 'delta', text: rawPart.text })
            }
          } else if (isRecord(rawPart.functionCall)) {
            const name = typeof rawPart.functionCall.name === 'string' ? rawPart.functionCall.name : undefined
            const args = isRecord(rawPart.functionCall.args) ? rawPart.functionCall.args : {}

            if (name) {
              toolCalls.push({
                id: createAgentId('tool_call'),
                name: name as AgentToolCall['name'],
                input: args,
                ...(typeof rawPart.thoughtSignature === 'string' && rawPart.thoughtSignature
                  ? { thoughtSignature: rawPart.thoughtSignature }
                  : {}),
              })
            }
          }
        }

        if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
          if (isSafetyStop(candidate.finishReason)) {
            safetyStopReason = candidate.finishReason
          } else {
            finishReason = mapFinishReason(candidate.finishReason)
          }
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

  // 安全类中止：模型响应被服务端掐断（无可用内容），按错误收场而非静默截断
  if (safetyStopReason) {
    const message = `模型响应被 Gemini 中止（finishReason: ${safetyStopReason}）`
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  const result: AgentAssistantResponse = {
    content,
    toolCalls,
    // gemini 函数调用轮的 finishReason 也是 STOP（无独立原因码），按实际内容推导：
    // 有函数调用 → tool_calls；否则按线上的 finishReason 归一
    finishReason: toolCalls.length > 0 ? 'tool_calls' : (finishReason ?? 'stop'),
    ...(reasoning ? { reasoning } : {}),
  }

  onEvent({ type: 'finish', response: result })
  return result
}

function buildGeminiRequestBody(input: ProtocolLlmInput) {
  const system = input.messages
    .filter((message): message is Extract<AgentMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const tools = input.tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeSchema(tool.function.parameters),
      },
    ],
  }))

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: toGeminiContents(input.messages),
    ...(tools.length ? { tools } : {}),
    ...(input.maxTokens !== undefined ? { generationConfig: { maxOutputTokens: input.maxTokens } } : {}),
  }
}

type GeminiPart =
  | { text: string; thought?: true }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { result: string } } }

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * 中立消息 → gemini contents。
 * 连续 tool 消息合并进同一 user 轮（多个 functionResponse parts）；
 * assistant 轮的 functionCall part 带 thoughtSignature 时原样回传。
 */
function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  const result: GeminiContent[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      continue
    }

    if (message.role === 'user') {
      result.push({ role: 'user', parts: [{ text: message.content }] })
      continue
    }

    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []

      if (message.content) {
        parts.push({ text: message.content })
      }

      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          functionCall: { name: toolCall.name, args: toolCall.input },
          ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
        })
      }

      if (parts.length === 0) {
        parts.push({ text: '' })
      }

      result.push({ role: 'model', parts })
      continue
    }

    const part: GeminiPart = {
      functionResponse: { name: message.name, response: { result: message.content } },
    }
    const last = result[result.length - 1]

    if (last && last.role === 'user' && last.parts[0] && 'functionResponse' in last.parts[0]) {
      last.parts.push(part)
    } else {
      result.push({ role: 'user', parts: [part] })
    }
  }

  return result
}

/** 剥离 gemini Schema 不认识的 OpenAI 风格字段（递归），避免未知字段校验拒绝。 */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema)
  }

  if (!isRecord(schema)) {
    return schema
  }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema') {
      continue
    }

    result[key] = sanitizeSchema(value)
  }

  return result
}

function mapFinishReason(reason: string): string {
  if (reason === 'MAX_TOKENS') {
    return 'length'
  }

  // STOP 及未知值
  return 'stop'
}

/** 安全/合规类中止：内容不可用，视为错误而非截断成功。 */
function isSafetyStop(reason: string): boolean {
  return (
    reason === 'SAFETY'
    || reason === 'RECITATION'
    || reason === 'BLOCKLIST'
    || reason === 'PROHIBITED_CONTENT'
    || reason === 'SPII'
    || reason === 'MALFORMED_FUNCTION_CALL'
    || reason === 'OTHER'
  )
}

/** 兼容 …、…/v1beta、…/v1 三种 baseUrl 写法（与 models-client 同款归一）。 */
function stripTrailingVersionSegments(baseUrl: string) {
  let result = baseUrl

  for (const segment of ['/v1beta', '/v1']) {
    if (result.endsWith(segment)) {
      result = result.slice(0, -segment.length)
    }
  }

  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
