import { createJsonHeaders, extractErrorMessage, isDeepSeekDialect, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../../ai/shared'
import { createAgentId } from '../../agent/messages'
import type {
  AgentAssistantResponse,
  AgentMessage,
  AgentToolCall,
} from '../../agent/messages'

import { AgentAbortedError } from './types'
import type { ProtocolAdapter, ProtocolLlmEvent, ProtocolLlmInput } from './types'

type PendingToolCall = {
  id?: string
  name?: string
  argumentsText: string
}

type CompletionRequestMode = 'stream' | 'non_streaming' | 'non_streaming_fallback'
type FallbackReason =
  | 'stream_tool_calls_missing_function_name'
  | 'stream_request_failed'

const LLM_STREAM_IDLE_TIMEOUT_MS = 90_000
const LLM_NON_STREAMING_TIMEOUT_MS = 300_000

/**
 * OpenAI Chat Completions 兼容适配器（/chat/completions）。
 *
 * 原 agent/llm.ts 的直连实现整体迁入：流式 tool_calls 容错（dropped 诊断）、
 * 非流式 fallback、空闲超时与用户 abort 语义全部保留；新增 DeepSeek 风格
 * `delta.reasoning_content` 思考流解析（→ reasoning-delta 事件 + reasoning 字段）。
 */
export const openAiChatAdapter: ProtocolAdapter = {
  protocol: 'openai',

  async stream(input: ProtocolLlmInput, onEvent: (event: ProtocolLlmEvent) => void): Promise<AgentAssistantResponse> {
    return streamOpenAiChat(input, onEvent)
  },
}

async function streamOpenAiChat(
  input: ProtocolLlmInput,
  onEvent: (event: ProtocolLlmEvent) => void,
): Promise<AgentAssistantResponse> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  // 用户在请求开始前就已经点了停止 —— 直接中止
  if (input.signal?.aborted) {
    throw new AgentAbortedError('')
  }

  onEvent({ type: 'start' })

  const timeout = createRequestTimeout(LLM_STREAM_IDLE_TIMEOUT_MS, '流式响应空闲')
  const decoder = new TextDecoder('utf-8')
  const pendingToolCalls = new Map<number, PendingToolCall>()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let chunkCount = 0
  let dataLineCount = 0
  let parseErrorCount = 0
  let toolCallDeltaCount = 0

  try {
    const response = await requestChatCompletion(input, baseUrl, true, timeout.signal)

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      const message = extractErrorMessage(payload, 'Agent 调用模型失败')
      onEvent({ type: 'error', message })
      throw new Error(message)
    }

    if (!response.body) {
      const payload = await readJsonResponse(response)
      const result = extractNonStreamingResponse(payload, 'non_streaming')
      onEvent({ type: 'finish', response: result })
      return result
    }

    const reader = response.body.getReader()

    while (true) {
      const { done, value } = await readStreamChunk(reader, timeout.signal, input.signal)

      if (done) {
        break
      }

      chunkCount += 1
      timeout.reset()
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        for (const line of chunk.split('\n').map((item) => item.trim()).filter(Boolean)) {
          if (!line.startsWith('data:')) {
            continue
          }

          const data = line.slice(5).trim()

          if (!data || data === '[DONE]') {
            continue
          }

          dataLineCount += 1

          try {
            const payload = JSON.parse(data)
            const choice = readFirstChoice(payload)

            if (!choice) {
              continue
            }

            if (typeof choice.finish_reason === 'string') {
              finishReason = choice.finish_reason
            }

            const delta = isRecord(choice.delta) ? choice.delta : undefined
            const deltaText = extractDeltaText(delta)
            const deltaReasoning = extractDeltaReasoning(delta)

            if (deltaText) {
              content += deltaText
              onEvent({ type: 'delta', text: deltaText })
            }

            if (deltaReasoning) {
              reasoning += deltaReasoning
              onEvent({ type: 'reasoning-delta', text: deltaReasoning })
            }

            toolCallDeltaCount += collectToolCallDeltas(delta, pendingToolCalls)
          } catch {
            parseErrorCount += 1
            continue
          }
        }
      }
    }
  } catch (error) {
    // 用户主动停止 —— 立即中断，保留已生成内容，不触发非流式 fallback
    if (isUserAbort(error, input.signal)) {
      throw new AgentAbortedError(content)
    }

    const fallback = await fallbackToNonStreaming(
      input,
      baseUrl,
      createStreamResult({
        content,
        reasoning,
        finishReason,
        pendingToolCalls,
        chunkCount,
        dataLineCount,
        parseErrorCount,
        toolCallDeltaCount,
      }),
      'stream_request_failed',
      error,
    )
    onEvent({ type: 'finish', response: fallback })
    return fallback
  } finally {
    timeout.clear()
  }

  const result = createStreamResult({
    content,
    reasoning,
    finishReason,
    pendingToolCalls,
    chunkCount,
    dataLineCount,
    parseErrorCount,
    toolCallDeltaCount,
  })

  if (shouldFallbackToNonStreaming(result)) {
    const fallback = await fallbackToNonStreaming(
      input,
      baseUrl,
      result,
      'stream_tool_calls_missing_function_name',
    )
    onEvent({ type: 'finish', response: fallback })
    return fallback
  }

  onEvent({ type: 'finish', response: result })
  return result
}

async function requestChatCompletion(
  input: ProtocolLlmInput,
  baseUrl: string,
  stream: boolean,
  signal: AbortSignal,
) {
  return fetch(resolveApiUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: createJsonHeaders(input.apiKey, baseUrl),
    signal,
    body: JSON.stringify({
      model: input.model.trim(),
      stream,
      messages: input.messages.map(toOpenAiMessage),
      tools: input.tools,
      tool_choice: 'auto',
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...resolveThinkingWire(input),
    }),
  })
}

/**
 * 思考档位 → wire 参数（思考强度计划 D2 映射表 openai 列；缺省档按 off 解析——默认关闭）。
 * - DeepSeek 方言：off → thinking:disabled；low/high/max → thinking:enabled + reasoning_effort；
 * - 其他兼容后端：reasoning_effort 两边都认识直接发（max 降级 high）；
 *   off 无法实现（OpenAI 官方无关闭参数）且 thinking 是方言字段不可发 → 不传。
 */
function resolveThinkingWire(input: ProtocolLlmInput) {
  const effort = input.reasoningEffort ?? 'off'

  if (isDeepSeekDialect(input.baseUrl)) {
    if (effort === 'off') {
      return { thinking: { type: 'disabled' } }
    }

    return { thinking: { type: 'enabled' }, reasoning_effort: effort }
  }

  if (effort === 'off') {
    return {}
  }

  return { reasoning_effort: effort === 'max' ? 'high' : effort }
}

function createStreamResult(input: {
  content: string
  reasoning: string
  finishReason?: string
  pendingToolCalls: Map<number, PendingToolCall>
  chunkCount: number
  dataLineCount: number
  parseErrorCount: number
  toolCallDeltaCount: number
}): AgentAssistantResponse {
  const finalized = finalizeToolCalls(input.pendingToolCalls)

  return {
    content: input.content,
    toolCalls: finalized,
    finishReason: input.finishReason,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    diagnostics: createDiagnostics({
      responseMode: 'stream',
      pendingToolCalls: input.pendingToolCalls,
      finalizedToolCallCount: finalized.length,
      chunkCount: input.chunkCount,
      dataLineCount: input.dataLineCount,
      parseErrorCount: input.parseErrorCount,
      toolCallDeltaCount: input.toolCallDeltaCount,
    }),
  }
}

function shouldFallbackToNonStreaming(response: AgentAssistantResponse) {
  return (
    response.finishReason === 'tool_calls' &&
    response.toolCalls.length === 0 &&
    (response.diagnostics?.droppedToolCallCount ?? 0) > 0
  )
}

async function fallbackToNonStreaming(
  input: ProtocolLlmInput,
  baseUrl: string,
  streamResult: AgentAssistantResponse,
  reason: FallbackReason,
  streamError?: unknown,
): Promise<AgentAssistantResponse> {
  const timeout = createRequestTimeout(LLM_NON_STREAMING_TIMEOUT_MS, '非流式 fallback')
  try {
    const response = await requestChatCompletion(input, baseUrl, false, timeout.signal)

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      throw new Error(extractErrorMessage(payload, 'Agent 非流式 fallback 调用模型失败'))
    }

    const payload = await readJsonResponse(response)
    const fallback = extractNonStreamingResponse(payload, 'non_streaming_fallback')
    const diagnostics = fallback.diagnostics

    if (!diagnostics) {
      return fallback
    }

    return {
      ...fallback,
      diagnostics: {
        ...diagnostics,
        fallback: {
          from: 'stream',
          to: 'non_streaming',
          reason,
          succeeded: true,
          originalToolCallCount: streamResult.toolCalls.length,
          originalDroppedToolCallCount: streamResult.diagnostics?.droppedToolCallCount ?? 0,
          errorMessage: formatFallbackSourceError(streamError),
        },
      },
    }
  } catch (error) {
    const diagnostics = streamResult.diagnostics

    if (!diagnostics) {
      throw createFallbackError(error, LLM_NON_STREAMING_TIMEOUT_MS, '非流式 fallback')
    }

    streamResult.diagnostics = {
      ...diagnostics,
      fallback: {
        from: 'stream',
        to: 'non_streaming',
        reason,
        succeeded: false,
        originalToolCallCount: streamResult.toolCalls.length,
        originalDroppedToolCallCount: streamResult.diagnostics?.droppedToolCallCount ?? 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    }

    throw createFallbackError(error, LLM_NON_STREAMING_TIMEOUT_MS, '非流式 fallback')
  } finally {
    timeout.clear()
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutSignal: AbortSignal,
  userSignal?: AbortSignal,
) {
  if (timeoutSignal.aborted) {
    throw timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error(String(timeoutSignal.reason))
  }

  if (userSignal?.aborted) {
    throw userSignal.reason instanceof Error ? userSignal.reason : new Error(String(userSignal.reason))
  }

  const settle = (resolve: (value: ReadableStreamReadResult<Uint8Array>) => void, reject: (error: unknown) => void, signal: AbortSignal) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }, { once: true })
  }

  const competitors: Promise<ReadableStreamReadResult<Uint8Array>>[] = [
    reader.read(),
    new Promise((_, reject) => settle(undefined as never, reject, timeoutSignal)),
  ]

  if (userSignal) {
    competitors.push(new Promise((_, reject) => settle(undefined as never, reject, userSignal)))
  }

  return Promise.race(competitors)
}

function createRequestTimeout(timeoutMs: number, label: string) {
  const controller = new AbortController()
  let timer = globalThis.setTimeout(() => {
    controller.abort(new Error(`LLM ${label}超过 ${timeoutMs / 1000} 秒未完成`))
  }, timeoutMs)

  return {
    signal: controller.signal,
    reset() {
      if (controller.signal.aborted) {
        return
      }

      globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => {
        controller.abort(new Error(`LLM ${label}超过 ${timeoutMs / 1000} 秒未完成`))
      }, timeoutMs)
    },
    clear() {
      globalThis.clearTimeout(timer)
    },
  }
}

function createFallbackError(error: unknown, timeoutMs: number, label: string) {
  if (isAbortError(error)) {
    return new Error(`模型${label}超过 ${timeoutMs / 1000} 秒未完成，请稍后重试或切换模型服务商`)
  }

  return error instanceof Error ? error : new Error(String(error))
}

function formatFallbackSourceError(error: unknown) {
  if (!error) {
    return undefined
  }

  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.message.includes('LLM ') && error.message.includes('超过'))
  )
}

/**
 * 判定一个错误是否由用户主动停止触发。
 * 三种来源：外部 signal 已 abort、错误本身是 AgentAbortedError、DOMException AbortError 且 signal 已 abort。
 */
function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof AgentAbortedError) {
    return true
  }

  if (!signal?.aborted) {
    return false
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }

  return false
}

function toOpenAiMessage(message: AgentMessage) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    }
  }

  if (message.role === 'assistant') {
    const toolCalls = message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input),
      },
    }))

    return {
      role: 'assistant',
      content: message.content || null,
      // 思考内容随历史回传：DeepSeek 思考模式下工具轮 assistant 消息不带 reasoning_content 会 400
      // （不产思考的模型没有 reasoning，字段天然缺省，其他兼容后端最多忽略）。
      ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    }
  }

  return message
}

function extractNonStreamingResponse(
  payload: unknown,
  responseMode: CompletionRequestMode,
): AgentAssistantResponse {
  const choice = readFirstChoice(payload)
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  const content = typeof message?.content === 'string' ? message.content : ''
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map(readFullToolCall).filter((item): item is AgentToolCall => item !== null)
    : []

  return {
    content,
    toolCalls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    ...(reasoning ? { reasoning } : {}),
    diagnostics: createDiagnostics({
      responseMode,
      pendingToolCalls: new Map(
        toolCalls.map((toolCall, index) => [
          index,
          {
            id: toolCall.id,
            name: toolCall.name,
            argumentsText: JSON.stringify(toolCall.input),
          },
        ]),
      ),
      finalizedToolCallCount: toolCalls.length,
      chunkCount: 0,
      dataLineCount: 0,
      parseErrorCount: 0,
      toolCallDeltaCount: toolCalls.length,
    }),
  }
}

function readFullToolCall(value: unknown): AgentToolCall | null {
  if (!isRecord(value) || !isRecord(value.function) || typeof value.function.name !== 'string') {
    return null
  }

  const input = parseToolArguments(
    typeof value.function.arguments === 'string' ? value.function.arguments : '{}',
  )

  return {
    id: typeof value.id === 'string' ? value.id : createAgentId('tool_call'),
    name: value.function.name as AgentToolCall['name'],
    input,
  }
}

function collectToolCallDeltas(
  delta: Record<string, unknown> | undefined,
  pendingToolCalls: Map<number, PendingToolCall>,
) {
  if (!delta || !Array.isArray(delta.tool_calls)) {
    return 0
  }

  let count = 0

  for (const rawToolCall of delta.tool_calls) {
    if (!isRecord(rawToolCall)) {
      continue
    }

    count += 1
    const index = typeof rawToolCall.index === 'number' ? rawToolCall.index : pendingToolCalls.size
    const pending = pendingToolCalls.get(index) ?? { argumentsText: '' }

    if (typeof rawToolCall.id === 'string') {
      pending.id = rawToolCall.id
    }

    if (isRecord(rawToolCall.function)) {
      if (typeof rawToolCall.function.name === 'string') {
        pending.name = rawToolCall.function.name
      }

      if (typeof rawToolCall.function.arguments === 'string') {
        pending.argumentsText += rawToolCall.function.arguments
      }
    }

    pendingToolCalls.set(index, pending)
  }

  return count
}

function finalizeToolCalls(pendingToolCalls: Map<number, PendingToolCall>): AgentToolCall[] {
  return Array.from(pendingToolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, value]) => ({
      id: value.id || createAgentId('tool_call'),
      name: value.name as AgentToolCall['name'],
      input: parseToolArguments(value.argumentsText),
    }))
    .filter((toolCall) => Boolean(toolCall.name))
}

function parseToolArguments(text: string): Record<string, unknown> {
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

function createDiagnostics(input: {
  responseMode: CompletionRequestMode
  pendingToolCalls: Map<number, PendingToolCall>
  finalizedToolCallCount: number
  chunkCount: number
  dataLineCount: number
  parseErrorCount: number
  toolCallDeltaCount: number
}) {
  const droppedToolCalls = Array.from(input.pendingToolCalls.entries())
    .filter(([, value]) => !value.name)
    .map(([index, value]) => ({
      index,
      hasId: Boolean(value.id),
      hasName: Boolean(value.name),
      argumentsLength: value.argumentsText.length,
      argumentsParseable: isParseableJsonObject(value.argumentsText),
    }))

  return {
    responseMode: input.responseMode,
    chunkCount: input.chunkCount,
    dataLineCount: input.dataLineCount,
    parseErrorCount: input.parseErrorCount,
    toolCallDeltaCount: input.toolCallDeltaCount,
    pendingToolCallCount: input.pendingToolCalls.size,
    finalizedToolCallCount: input.finalizedToolCallCount,
    droppedToolCallCount: droppedToolCalls.length,
    droppedToolCalls,
  }
}

function isParseableJsonObject(text: string) {
  if (!text.trim()) {
    return true
  }

  try {
    return isRecord(JSON.parse(text))
  } catch {
    return false
  }
}

function extractDeltaText(delta: Record<string, unknown> | undefined) {
  if (!delta || !('content' in delta)) {
    return ''
  }

  if (typeof delta.content === 'string') {
    return delta.content
  }

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item) => {
        if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
          return item.text
        }

        return ''
      })
      .join('')
  }

  return ''
}

/** DeepSeek reasoner 风格思考流增量（delta.reasoning_content）。 */
function extractDeltaReasoning(delta: Record<string, unknown> | undefined) {
  if (!delta || typeof delta.reasoning_content !== 'string') {
    return ''
  }

  return delta.reasoning_content
}

function readFirstChoice(payload: unknown) {
  if (isRecord(payload) && Array.isArray(payload.choices) && payload.choices.length > 0) {
    return isRecord(payload.choices[0]) ? payload.choices[0] : null
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
