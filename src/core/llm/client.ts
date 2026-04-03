import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse } from '../ai/shared'

import type {
  LlmStreamEvent,
  LlmStreamInput,
  ModelConnectionInput,
  ModelConnectionResult,
} from '../../types/ai'

/**
 * 使用 OpenAI 兼容的 `/models` 接口测试 LLM 配置是否可用。
 * 返回值已经整理成适合直接展示给用户的结果结构。
 */
export async function testLlmConnection(
  input: Omit<ModelConnectionInput, 'kind'>,
): Promise<ModelConnectionResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim()) {
    return {
      ok: false,
      message: '请先填写 API 地址和 API Key',
    }
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: createJsonHeaders(input.apiKey),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      return {
        ok: false,
        message: extractErrorMessage(payload, 'LLM 测试连接失败'),
      }
    }

    return {
      ok: true,
      message: 'LLM 连接成功',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'LLM 测试连接失败',
    }
  }
}

/**
 * 发起一次最小化的流式对话生成，并把底层 SSE 数据适配成统一事件流。
 * 调用方只需要监听 `start / delta / finish / error`，无需关心原始 chunk 格式。
 */
export async function streamChatCompletion(
  input: LlmStreamInput,
  onEvent: (event: LlmStreamEvent) => void,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model.trim()) {
    const message = '请先填写 LLM 的 API 地址、API Key 和模型名称'
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  const messages = []

  if (input.systemPrompt?.trim()) {
    messages.push({
      role: 'system',
      content: input.systemPrompt.trim(),
    })
  }

  messages.push({
    role: 'user',
    content: input.instruction.trim(),
  })

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: createJsonHeaders(input.apiKey),
    body: JSON.stringify({
      model: input.model.trim(),
      stream: true,
      messages,
    }),
  })

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    const message = extractErrorMessage(payload, '章节生成失败')
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  if (!response.body) {
    const payload = await readJsonResponse(response)
    const text = extractCompletionText(payload)
    onEvent({ type: 'start' })
    onEvent({ type: 'finish', text })
    return text
  }

  onEvent({ type: 'start' })

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    // OpenAI 兼容流通常以空行分隔事件，这里先按事件块切开，再逐行解析 data。
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const lines = chunk
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }

        const data = line.slice(5).trim()

        if (!data || data === '[DONE]') {
          continue
        }

        try {
          const payload = JSON.parse(data)
          const deltaText = extractDeltaText(payload)

          if (deltaText) {
            fullText += deltaText
            onEvent({ type: 'delta', text: deltaText })
          }
        } catch {
          continue
        }
      }
    }
  }

  onEvent({ type: 'finish', text: fullText })
  return fullText
}

function extractDeltaText(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'choices' in payload &&
    Array.isArray(payload.choices) &&
    payload.choices.length > 0
  ) {
    const firstChoice = payload.choices[0]

    if (
      firstChoice &&
      typeof firstChoice === 'object' &&
      'delta' in firstChoice &&
      firstChoice.delta &&
      typeof firstChoice.delta === 'object' &&
      'content' in firstChoice.delta
    ) {
      const content = firstChoice.delta.content

      if (typeof content === 'string') {
        return content
      }

      if (Array.isArray(content)) {
        // 一些兼容实现会把内容拆成富文本片段数组，这里只抽取 text 片段并拼回纯文本。
        return content
          .map((item) => {
            if (
              item &&
              typeof item === 'object' &&
              'type' in item &&
              item.type === 'text' &&
              'text' in item &&
              typeof item.text === 'string'
            ) {
              return item.text
            }

            return ''
          })
          .join('')
      }
    }
  }

  return ''
}

function extractCompletionText(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'choices' in payload &&
    Array.isArray(payload.choices) &&
    payload.choices.length > 0
  ) {
    const firstChoice = payload.choices[0]

    if (
      firstChoice &&
      typeof firstChoice === 'object' &&
      'message' in firstChoice &&
      firstChoice.message &&
      typeof firstChoice.message === 'object' &&
      'content' in firstChoice.message &&
      typeof firstChoice.message.content === 'string'
    ) {
      return firstChoice.message.content
    }
  }

  return ''
}
