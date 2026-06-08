import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion } from './llm'
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
