import {
  createJsonHeaders,
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

type PendingFunctionCall = {
  callId?: string
  name?: string
  argumentsText: string
}

/**
 * OpenAI Responses 适配器（POST {base}/responses，SSE 流式，stateless 全量 input 模式）。
 *
 * - 不使用 previous_response_id：每次请求带完整历史，会话状态由 NovAI 自持；
 * - system prompt → 顶层 `instructions`；历史 → input items（user=input_text、
 *   assistant=output_text、工具调用=function_call、工具结果=function_call_output）；
 * - 工具从 output_item.done 的完整 function_call item 收集（arguments 全串，无需增量累积）；
 * - 思考流：response.reasoning_summary_text.delta → reasoning-delta；
 * - finishReason 归一：output 含 function_call → tool_calls；response.incomplete → length；
 *   response.completed → stop；response.failed / error 事件 → 错误；
 * - 鉴权 Bearer；无真机（mock wire 测试兜底，待有 key 后复核）。
 */
export const openAiResponsesAdapter: ProtocolAdapter = {
  protocol: 'openai-responses',

  async stream(input: ProtocolLlmInput, onEvent: (event: ProtocolLlmEvent) => void): Promise<AgentAssistantResponse> {
    return streamOpenAiResponses(input, onEvent)
  },
}

async function streamOpenAiResponses(
  input: ProtocolLlmInput,
  onEvent: (event: ProtocolLlmEvent) => void,
): Promise<AgentAssistantResponse> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (input.signal?.aborted) {
    throw new AgentAbortedError('')
  }

  onEvent({ type: 'start' })

  const timeout = createRequestTimeout(STREAM_IDLE_TIMEOUT_MS, '流式响应空闲')
  const functionCalls = new Map<number, PendingFunctionCall>()
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let failureMessage: string | undefined

  try {
    const response = await fetch(resolveApiUrl(baseUrl, '/responses'), {
      method: 'POST',
      headers: createJsonHeaders(input.apiKey, baseUrl),
      signal: timeout.signal,
      body: JSON.stringify(buildResponsesRequestBody(input)),
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
          case 'response.output_text.delta': {
            const delta = typeof payload.delta === 'string' ? payload.delta : ''

            if (delta) {
              content += delta
              onEvent({ type: 'delta', text: delta })
            }
            break
          }
          case 'response.reasoning_summary_text.delta': {
            const delta = typeof payload.delta === 'string' ? payload.delta : ''

            if (delta) {
              reasoning += delta
              onEvent({ type: 'reasoning-delta', text: delta })
            }
            break
          }
          case 'response.output_item.done': {
            const item = payload.item

            if (isRecord(item) && item.type === 'function_call') {
              functionCalls.set(readIndex(payload.output_index), {
                callId: typeof item.call_id === 'string' ? item.call_id : undefined,
                name: typeof item.name === 'string' ? item.name : undefined,
                argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
              })
            }
            break
          }
          case 'response.completed': {
            const output = isRecord(payload.response) && Array.isArray(payload.response.output)
              ? payload.response.output
              : []
            const hasFunctionCall = output.some((item) => isRecord(item) && item.type === 'function_call')
            finishReason = hasFunctionCall || functionCalls.size > 0 ? 'tool_calls' : 'stop'
            break
          }
          case 'response.incomplete': {
            finishReason = 'length'
            break
          }
          case 'response.failed': {
            const error = isRecord(payload.response) ? payload.response.error : undefined
            failureMessage = isRecord(error) && typeof error.message === 'string'
              ? error.message
              : '模型响应失败（response.failed）'
            break
          }
          case 'error': {
            failureMessage = typeof payload.message === 'string'
              ? payload.message
              : '模型流式返回错误'
            break
          }
          default:
            // response.created / in_progress / output_item.added / content_part.* 等
            // 过程事件与各 *.done 全量事件忽略（增量与最终态已在上面消费）
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

  if (failureMessage) {
    onEvent({ type: 'error', message: failureMessage })
    throw new Error(failureMessage)
  }

  const toolCalls = finalizeFunctionCalls(functionCalls)
  const result: AgentAssistantResponse = {
    content,
    toolCalls,
    finishReason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    ...(reasoning ? { reasoning } : {}),
  }

  onEvent({ type: 'finish', response: result })
  return result
}

function buildResponsesRequestBody(input: ProtocolLlmInput) {
  const instructions = input.messages
    .filter((message): message is Extract<AgentMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const tools = input.tools.map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))

  return {
    model: input.model.trim(),
    stream: true,
    ...(instructions ? { instructions } : {}),
    input: toResponsesInput(input.messages),
    ...(tools.length ? { tools } : {}),
    ...(input.maxTokens !== undefined ? { max_output_tokens: input.maxTokens } : {}),
    ...resolveThinkingWire(input),
  }
}

/**
 * 思考档位 → reasoning.effort（思考强度计划 D2 映射表 responses 列；缺省档按 off 解析——默认关闭）。
 * Responses API 无关闭思考参数（gpt-5 系列默认思考、关不掉），off 不传（UI 侧也不显示该档）；
 * effort 档位集合无 max，降级 high。
 */
function resolveThinkingWire(input: ProtocolLlmInput) {
  const effort = input.reasoningEffort ?? 'off'

  if (effort === 'off') {
    return {}
  }

  return { reasoning: { effort: effort === 'max' ? 'high' : effort } }
}

type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** 中立消息 → Responses input items（stateless 全量模式，不依赖服务端会话状态）。 */
function toResponsesInput(messages: AgentMessage[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      continue
    }

    if (message.role === 'user') {
      result.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message.content }],
      })
      continue
    }

    if (message.role === 'assistant') {
      if (message.content) {
        result.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        })
      }

      for (const toolCall of message.toolCalls ?? []) {
        result.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        })
      }
      continue
    }

    result.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    })
  }

  return result
}

function finalizeFunctionCalls(functionCalls: Map<number, PendingFunctionCall>): AgentToolCall[] {
  return Array.from(functionCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, value]) => ({
      id: value.callId || createAgentId('tool_call'),
      name: value.name as AgentToolCall['name'],
      input: parseArguments(value.argumentsText),
    }))
    .filter((toolCall) => Boolean(toolCall.name))
}

function parseArguments(text: string): Record<string, unknown> {
  if (!text.trim()) {
    return {}
  }

  try {
    const value = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function readIndex(value: unknown): number {
  return typeof value === 'number' ? value : -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
