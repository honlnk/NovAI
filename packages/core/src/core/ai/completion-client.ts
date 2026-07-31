import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../ai/shared'

import type { ModelConnectionInput, ModelConnectionResult } from '../../types/ai'

/**
 * FIM 补全请求输入。prompt 为光标前文本（前缀），suffix 为光标后文本（后缀）。
 * signal 用于在用户继续打字时中断上一次未完成的请求。
 */
export type FimCompletionInput = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  suffix?: string
  maxTokens?: number
  signal?: AbortSignal
}

export type FimCompletionEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; text: string }
  | { type: 'error'; message: string }

/**
 * 用户主动中断补全时抛出的错误，用于在调用方区分「取消」与「失败」。
 */
export class CompletionAbortedError extends Error {
  readonly aborted = true
  readonly partialContent: string

  constructor(partialContent: string) {
    super('补全已被取消')
    this.name = 'CompletionAbortedError'
    this.partialContent = partialContent
  }
}

/** FIM 流式响应的空闲超时：超过该时长未收到任何 chunk 即判定请求卡死。 */
const FIM_STREAM_IDLE_TIMEOUT_MS = 15_000

/**
 * 发起一次 FIM 流式补全，把底层 SSE 数据适配成统一事件流。
 *
 * 与 streamChatCompletion 的区别：
 * - 走 DeepSeek FIM 的 `/completions`（非 `/chat/completions`），请求体用 prompt + suffix。
 * - 流式增量在 `choices[0].text`（legacy completions 协议），而非 `choices[0].delta.content`。
 * - 支持 AbortSignal：用户继续打字时立即中断上一次未完成的请求，保留已生成的部分内容。
 */
export async function streamFimCompletion(
  input: FimCompletionInput,
  onEvent: (event: FimCompletionEvent) => void,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model.trim()) {
    const message = '请先填写补全模型的 API 地址、API Key 和模型名称'
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  // 请求开始前用户已停止 —— 直接中止，保留空内容
  if (input.signal?.aborted) {
    throw new CompletionAbortedError('')
  }

  onEvent({ type: 'start' })

  const timeout = createRequestTimeout(FIM_STREAM_IDLE_TIMEOUT_MS)
  let content = ''

  try {
    const response = await fetch(resolveApiUrl(baseUrl, '/completions'), {
      method: 'POST',
      headers: createJsonHeaders(input.apiKey, baseUrl),
      signal: timeout.signal,
      body: JSON.stringify({
        model: input.model.trim(),
        prompt: input.prompt,
        suffix: input.suffix ?? '',
        stream: true,
        max_tokens: input.maxTokens ?? 64,
        stop: ['\n'],
      }),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      const message = extractErrorMessage(payload, '补全请求失败')
      onEvent({ type: 'error', message })
      throw new Error(message)
    }

    // 非流式兜底：某些实现可能直接返回完整 JSON 而非 SSE
    if (!response.body) {
      const payload = await readJsonResponse(response)
      const text = extractFimCompletionText(payload)
      onEvent({ type: 'finish', text })
      return text
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { done, value } = await readStreamChunk(reader, timeout.signal, input.signal)
      if (done) {
        break
      }

      timeout.reset()

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
            const deltaText = extractFimDeltaText(payload)

            if (deltaText) {
              content += deltaText
              onEvent({ type: 'delta', text: deltaText })
            }
          } catch {
            continue
          }
        }
      }
    }

    onEvent({ type: 'finish', text: content })
    return content
  } catch (error) {
    // 用户主动停止 —— 立即中断，保留已生成内容，不视为失败
    if (isUserAbort(error, input.signal)) {
      throw new CompletionAbortedError(content)
    }
    const message = error instanceof Error ? error.message : '补全请求失败'
    onEvent({ type: 'error', message })
    throw error
  } finally {
    timeout.clear()
  }
}

/**
 * 测试补全模型连接是否可用（走 `/models`）。
 */
export async function testCompletionConnection(
  input: Omit<ModelConnectionInput, 'kind'>,
): Promise<ModelConnectionResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim()) {
    return {
      ok: false,
      message: '请先填写补全模型的 API 地址和 API Key',
    }
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: createJsonHeaders(input.apiKey, baseUrl),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      return {
        ok: false,
        message: extractErrorMessage(payload, '补全模型测试连接失败'),
      }
    }

    return {
      ok: true,
      message: '补全模型连接成功',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '补全模型测试连接失败',
    }
  }
}

/**
 * 从 FIM 流式 chunk 中提取文本增量。
 *
 * DeepSeek FIM 走 legacy completions 协议，增量在 `choices[0].text`；
 * 同时兜底 `choices[0].delta.content`，应对某些代理网关的改写。
 */
function extractFimDeltaText(payload: unknown): string {
  const choice = extractFirstChoice(payload)
  if (!choice) {
    return ''
  }

  // legacy completions：choices[0].text
  if ('text' in choice && typeof choice.text === 'string') {
    return choice.text
  }

  // chat 兼容兜底：choices[0].delta.content
  if (
    'delta' in choice &&
    choice.delta &&
    typeof choice.delta === 'object' &&
    'content' in choice.delta &&
    typeof choice.delta.content === 'string'
  ) {
    return choice.delta.content
  }

  return ''
}

/** 从非流式响应中提取完整文本。 */
function extractFimCompletionText(payload: unknown): string {
  const choice = extractFirstChoice(payload)
  if (!choice) {
    return ''
  }

  if ('text' in choice && typeof choice.text === 'string') {
    return choice.text
  }

  return ''
}

function extractFirstChoice(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'choices' in payload &&
    Array.isArray(payload.choices) &&
    payload.choices.length > 0
  ) {
    const firstChoice = payload.choices[0]
    if (firstChoice && typeof firstChoice === 'object') {
      return firstChoice as Record<string, unknown>
    }
  }

  return null
}

/**
 * reader.read() 与 timeoutSignal、userSignal 三路竞速。
 * 任一 signal abort 就 reject，从而打断正在进行的 read。
 */
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

  const settle = (
    _resolve: (value: ReadableStreamReadResult<Uint8Array>) => void,
    reject: (error: unknown) => void,
    signal: AbortSignal,
  ) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      },
      { once: true },
    )
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

/**
 * 空闲超时控制器：每收到一个 chunk 调 reset() 重新计时，超时则 abort。
 */
function createRequestTimeout(timeoutMs: number) {
  const controller = new AbortController()
  let timer = globalThis.setTimeout(() => {
    controller.abort(new Error(`补全流式响应空闲超过 ${timeoutMs / 1000} 秒未完成`))
  }, timeoutMs)

  return {
    signal: controller.signal,
    reset() {
      if (controller.signal.aborted) {
        return
      }

      globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => {
        controller.abort(new Error(`补全流式响应空闲超过 ${timeoutMs / 1000} 秒未完成`))
      }, timeoutMs)
    },
    clear() {
      globalThis.clearTimeout(timer)
    },
  }
}

/**
 * 判定一个错误是否由用户主动停止触发。
 */
function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof CompletionAbortedError) {
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
