import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion, AgentAbortedError } from './llm'
import type { AgentToolSchema } from './messages'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('streamAgentCompletion', () => {
  it('falls back to non-streaming when streaming tool calls miss function names', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createStreamingResponse([
        {
          choices: [
            {
              delta: {
                content: '你好',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_missing_name',
                    type: 'function',
                    function: {
                      arguments: '{}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '你好！我先看看项目目录。',
              tool_calls: [
                {
                  id: 'call_list_directory',
                  type: 'function',
                  function: {
                    name: 'ListDirectory',
                    arguments: '{"path":""}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'test-key',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '你好 你能帮我做什么？' },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream).toBe(false)
    expect(result.toolCalls).toEqual([
      {
        id: 'call_list_directory',
        name: 'ListDirectory',
        input: { path: '' },
      },
    ])
    expect(result.diagnostics?.responseMode).toBe('non_streaming_fallback')
    expect(result.diagnostics?.fallback).toMatchObject({
      from: 'stream',
      to: 'non_streaming',
      reason: 'stream_tool_calls_missing_function_name',
      succeeded: true,
      originalToolCallCount: 0,
      originalDroppedToolCallCount: 1,
    })
  })

  it('falls back to non-streaming when the streaming body does not finish', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>()))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '项目读取完成。',
            },
            finish_reason: 'stop',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    globalThis.fetch = fetchMock

    const resultPromise = streamAgentCompletion({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'test-key',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '你好 你能帮我做什么？' },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})

    await vi.advanceTimersByTimeAsync(90_000)
    const result = await resultPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream).toBe(false)
    expect(result.content).toBe('项目读取完成。')
    expect(result.diagnostics?.responseMode).toBe('non_streaming_fallback')
    expect(result.diagnostics?.fallback).toMatchObject({
      from: 'stream',
      to: 'non_streaming',
      reason: 'stream_request_failed',
      succeeded: true,
      originalToolCallCount: 0,
    })
  })

  it('uses a longer timeout for non-streaming fallback requests', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>()))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        }, { once: true })
      }))

    globalThis.fetch = fetchMock

    const resultPromise = streamAgentCompletion({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'test-key',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '总结第一章。' },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})
    const errorPromise = resultPromise.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(299_999)
    await expect(Promise.resolve()).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await expect(errorPromise).resolves.toEqual(expect.objectContaining({
      message: expect.stringContaining('模型非流式 fallback超过 300 秒未完成'),
    }))
  })

  it('aborts immediately and does not fall back to non-streaming when the user signal aborts', async () => {
    const userController = new AbortController()
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // fetch 的 signal 既是超时也是用户 abort 的载体；这里让它与用户 controller 联动
      init.signal?.addEventListener('abort', () => {
        if (!userController.signal.aborted) userController.abort()
      })

      let firstChunkSent = false
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        // poll 循环：第一个 chunk 吐出后，后续每次 pull 都检查用户是否已 abort
        async pull(controller) {
          if (!firstChunkSent) {
            firstChunkSent = true
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前面这段"}}]}\n\n'))
            return
          }

          // 等待用户 abort（最多等一小段，避免空转）
          if (userController.signal.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'))
            return
          }

          await new Promise((resolve) => setTimeout(resolve, 5))
          if (userController.signal.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'))
          }
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
    })

    globalThis.fetch = fetchMock

    // 启动后稍等让第一个 chunk 被消费，再触发用户停止
    const promise = streamAgentCompletion({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'test-key',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: '写第一章' }],
      tools: [listDirectoryToolSchema],
      signal: userController.signal,
    }, () => {})

    // 让第一个 delta 被消费
    await new Promise((resolve) => setTimeout(resolve, 20))
    userController.abort()

    const error = await promise.catch((e: unknown) => e)

    // 关键：fetch 只调用一次（没有 fallback 到非流式重试）
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(AgentAbortedError)
    expect((error as AgentAbortedError).partialContent).toBe('前面这段')
  })

  it('throws AgentAbortedError immediately if the signal is already aborted before the request', async () => {
    const userController = new AbortController()
    userController.abort()
    const fetchMock = vi.fn()

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'test-key',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [
        { role: 'user', content: '写第一章' },
      ],
      tools: [listDirectoryToolSchema],
      signal: userController.signal,
    }, () => {})
    const error = await promise.catch((e: unknown) => e)

    // 请求开始前已停止：根本不会发起任何 fetch
    expect(fetchMock).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(AgentAbortedError)
  })
})

function createStreamingResponse(payloads: unknown[]) {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('') + 'data: [DONE]\n\n'

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const listDirectoryToolSchema: AgentToolSchema = {
  type: 'function',
  function: {
    name: 'ListDirectory',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
}
