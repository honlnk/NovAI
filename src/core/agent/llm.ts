import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../ai/shared'

import { createAgentId } from './messages'
import type {
  AgentAssistantResponse,
  AgentMessage,
  AgentToolCall,
  AgentToolSchema,
} from './messages'

export type AgentLlmInput = {
  baseUrl: string
  apiKey: string
  model: string
  messages: AgentMessage[]
  tools: AgentToolSchema[]
}

export type AgentLlmEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; response: AgentAssistantResponse }
  | { type: 'error'; message: string }

type PendingToolCall = {
  id?: string
  name?: string
  argumentsText: string
}

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

  const response = await fetch(resolveApiUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: createJsonHeaders(input.apiKey, baseUrl),
    body: JSON.stringify({
      model: input.model.trim(),
      stream: true,
      messages: input.messages.map(toOpenAiMessage),
      tools: input.tools,
      tool_choice: 'auto',
    }),
  })

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    const message = extractErrorMessage(payload, 'Agent 调用模型失败')
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  if (!response.body) {
    const payload = await readJsonResponse(response)
    const result = extractNonStreamingResponse(payload)
    onEvent({ type: 'start' })
    onEvent({ type: 'finish', response: result })
    return result
  }

  onEvent({ type: 'start' })

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const pendingToolCalls = new Map<number, PendingToolCall>()
  let buffer = ''
  let content = ''
  let finishReason: string | undefined

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

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

          if (deltaText) {
            content += deltaText
            onEvent({ type: 'delta', text: deltaText })
          }

          collectToolCallDeltas(delta, pendingToolCalls)
        } catch {
          continue
        }
      }
    }
  }

  const result = {
    content,
    toolCalls: finalizeToolCalls(pendingToolCalls),
    finishReason,
  }

  onEvent({ type: 'finish', response: result })
  return result
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
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    }
  }

  return message
}

function extractNonStreamingResponse(payload: unknown): AgentAssistantResponse {
  const choice = readFirstChoice(payload)
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  const content = typeof message?.content === 'string' ? message.content : ''
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map(readFullToolCall).filter((item): item is AgentToolCall => item !== null)
    : []

  return {
    content,
    toolCalls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
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
    return
  }

  for (const rawToolCall of delta.tool_calls) {
    if (!isRecord(rawToolCall)) {
      continue
    }

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

function readFirstChoice(payload: unknown) {
  if (isRecord(payload) && Array.isArray(payload.choices) && payload.choices.length > 0) {
    return isRecord(payload.choices[0]) ? payload.choices[0] : null
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
