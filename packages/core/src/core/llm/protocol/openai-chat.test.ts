import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion, AgentAbortedError } from '../../agent/llm'
import type { AgentToolSchema } from '../../agent/messages'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('openai-chat adapter (via streamAgentCompletion)', () => {
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

  it('emits reasoning-delta events and returns reasoning from reasoning_content stream deltas', async () => {
    const events: Array<{ type: string; text?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(createStreamingResponse([
      { choices: [{ delta: { reasoning_content: '先想想' } }] },
      { choices: [{ delta: { reasoning_content: '怎么写' } }] },
      { choices: [{ delta: { content: '好的，' } }] },
      { choices: [{ delta: { content: '这是正文。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: '写一句话' }],
      tools: [],
    }, (event) => {
      if (event.type === 'delta' || event.type === 'reasoning-delta') {
        events.push({ type: event.type, text: event.text })
      }
    })

    expect(events).toEqual([
      { type: 'reasoning-delta', text: '先想想' },
      { type: 'reasoning-delta', text: '怎么写' },
      { type: 'delta', text: '好的，' },
      { type: 'delta', text: '这是正文。' },
    ])
    expect(result.content).toBe('好的，这是正文。')
    expect(result.reasoning).toBe('先想想怎么写')
    expect(result.finishReason).toBe('stop')
  })

  it('extracts reasoning from non-streaming fallback responses', async () => {
    // 流式 tool_calls 丢函数名 → 触发非流式 fallback；fallback 响应带 reasoning_content
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
                    function: { arguments: '{}' },
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
              content: '正文内容。',
              reasoning_content: '思考过程。',
            },
            finish_reason: 'stop',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: '写一句话' }],
      tools: [listDirectoryToolSchema],
    }, () => {})

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream).toBe(false)
    expect(result.content).toBe('正文内容。')
    expect(result.reasoning).toBe('思考过程。')
    expect(result.diagnostics?.responseMode).toBe('non_streaming_fallback')
  })

  it('replays reasoning_content on assistant history messages (DeepSeek thinking-mode tool turns)', async () => {
    // mockImplementation 而非 mockResolvedValue：Response body 只能读一次，每次 fetch 都要新流
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(createStreamingResponse([
        { choices: [{ delta: { content: '读取完成。' }, finish_reason: 'stop' }] },
      ])))
    globalThis.fetch = fetchMock

    await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: '读一下章节' },
        {
          role: 'assistant',
          content: '',
          reasoning: '用户要读章节，调用 ReadFile。',
          toolCalls: [{ id: 'call_r', name: 'ReadFile', input: { path: 'chapters/001.txt' } }],
        },
        { role: 'tool', toolCallId: 'call_r', name: 'ReadFile', content: '第一章正文' },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})

    const wireMessages = JSON.parse(fetchMock.mock.calls[0][1].body).messages
    const toolTurnAssistant = wireMessages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    )
    expect(toolTurnAssistant).toMatchObject({ reasoning_content: '用户要读章节，调用 ReadFile。' })
    // 无思考的 assistant 轮不携带该字段（不产思考的模型天然缺省）
    const plainAssistant = { role: 'assistant', content: '旧回复' }
    await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }, plainAssistant as never],
      tools: [],
    }, () => {})
    const secondBodyMessages = JSON.parse(fetchMock.mock.calls[1][1].body).messages
    expect(secondBodyMessages.find((m: { role: string }) => m.role === 'assistant')).not.toHaveProperty('reasoning_content')
  })

  it('maps reasoning effort per dialect (D2 table): DeepSeek thinking+effort, other backends effort-only with off/max degraded', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(createStreamingResponse([
        { choices: [{ delta: { content: '好的。' }, finish_reason: 'stop' }] },
      ])))
    globalThis.fetch = fetchMock

    // DeepSeek 方言（baseUrl 含 deepseek）
    for (const effort of ['off', 'low', 'high', 'max'] as const) {
      await streamAgentCompletion({
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'test-key',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        reasoningEffort: effort,
      }, () => {})
    }
    // 非 DeepSeek 后端（SiliconFlow 等 openai 兼容网关）
    for (const effort of ['off', 'low', 'max'] as const) {
      await streamAgentCompletion({
        protocol: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'test-key',
        model: 'some-model',
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        reasoningEffort: effort,
      }, () => {})
    }
    // 缺省（default 档）
    await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
    // DeepSeek 方言四档
    expect(bodies[0].thinking).toEqual({ type: 'disabled' })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1].thinking).toEqual({ type: 'enabled' })
    expect(bodies[1].reasoning_effort).toBe('low')
    expect(bodies[2].reasoning_effort).toBe('high')
    expect(bodies[3].reasoning_effort).toBe('max')
    // 非方言：thinking 是 DeepSeek 方言字段不可发；off 无法实现不传；max 降级 high
    expect(bodies[4]).not.toHaveProperty('thinking')
    expect(bodies[4]).not.toHaveProperty('reasoning_effort')
    expect(bodies[5].reasoning_effort).toBe('low')
    expect(bodies[6].reasoning_effort).toBe('high')
    // default 档：两个参数都不传
    expect(bodies[7]).not.toHaveProperty('thinking')
    expect(bodies[7]).not.toHaveProperty('reasoning_effort')
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
