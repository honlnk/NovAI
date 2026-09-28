import { AgentAbortedError } from './types'

/**
 * SSE 流消费工具（anthropic / gemini / openai-responses 适配器共用）：
 * 网络块读取 + `\n\n` 帧切分 + `data:` 行提取 + 空闲超时 + 用户停止竞速。
 * 语义与 openai-chat 适配器一致（90 秒空闲超时、abort 即断），但不含非流式 fallback。
 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000

export function createRequestTimeout(timeoutMs: number, label: string) {
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

  const settle = (reject: (error: unknown) => void, signal: AbortSignal) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }, { once: true })
  }

  const competitors: Promise<ReadableStreamReadResult<Uint8Array>>[] = [
    reader.read(),
    new Promise((_, reject) => settle(reject, timeoutSignal)),
  ]

  if (userSignal) {
    competitors.push(new Promise((_, reject) => settle(reject, userSignal)))
  }

  return Promise.race(competitors)
}

/**
 * 逐条消费 SSE 响应体的 `data:` 行。
 * 每收到一个网络块重置空闲超时；onData 抛出的错误原样上抛（供适配器统一归类）。
 */
export async function consumeSseData(
  body: ReadableStream<Uint8Array>,
  options: {
    label: string
    idleTimeoutMs?: number
    timeoutSignal: AbortSignal
    /** 每收到网络块后的回调（适配器据此 reset 超时句柄）。 */
    onChunk?: () => void
    userSignal?: AbortSignal
    onData: (data: string) => void
  },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, options.timeoutSignal, options.userSignal)

      if (done) {
        break
      }

      options.onChunk?.()
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        for (const line of frame.split('\n').map((item) => item.trim()).filter(Boolean)) {
          if (!line.startsWith('data:')) {
            continue
          }

          const data = line.slice(5).trim()

          if (!data || data === '[DONE]') {
            continue
          }

          options.onData(data)
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * 判定一个错误是否由用户主动停止触发。
 * 三种来源：外部 signal 已 abort、错误本身是 AgentAbortedError、DOMException AbortError 且 signal 已 abort。
 */
export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
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
