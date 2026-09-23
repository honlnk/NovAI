import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion } from '../../agent/llm'
import type { AgentToolSchema } from '../../agent/messages'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('anthropic adapter (via streamAgentCompletion)', () => {
  it('builds the wire request: system top-level, tool_result merged into one user turn, max_tokens default', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '列出目录' },
        {
          role: 'assistant',
          content: '我来看一下。',
          toolCalls: [{ id: 'toolu_01', name: 'ListDirectory', input: { path: '' } }],
        },
        { role: 'tool', toolCallId: 'toolu_01', name: 'ListDirectory', content: 'chapter-001.txt' },
        { role: 'user', content: '谢谢' },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})

    expect(result.content).toBe('好的。')
    expect(result.finishReason).toBe('stop')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    })
    expect(init.headers).not.toHaveProperty('Authorization')

    const body = JSON.parse(init.body)
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.max_tokens).toBe(8192)
    expect(body.stream).toBe(true)
    expect(body.system).toBe('你是小说创作 Agent。')
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '列出目录' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来看一下。' },
          { type: 'tool_use', id: 'toolu_01', name: 'ListDirectory', input: { path: '' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: 'chapter-001.txt' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '谢谢' }] },
    ])
    expect(body.tools).toEqual([
      {
        name: 'ListDirectory',
        description: '列出目录',
        input_schema: listDirectoryToolSchema.function.parameters,
      },
    ])
  })

  it('tolerates baseUrl with trailing /v1 and passes explicit maxTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'message_stop' },
    ]))

    globalThis.fetch = fetchMock

    await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1/',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '总结' }],
      tools: [],
      maxTokens: 512,
    }, () => {})

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(512)
    // 无工具时请求体不带 tools 字段
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('tools')
  })

  it('streams thinking, text and tool_use blocks and normalizes the finish reason', async () => {
    const events: Array<{ type: string; text?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想想。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我看下目录。' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_02', name: 'ListDirectory', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"chapters"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
      { type: 'ping' },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '列出 chapters 目录' }],
      tools: [listDirectoryToolSchema],
    }, (event) => {
      if (event.type === 'delta' || event.type === 'reasoning-delta') {
        events.push({ type: event.type, text: event.text })
      }
    })

    expect(events).toEqual([
      { type: 'reasoning-delta', text: '先想想。' },
      { type: 'delta', text: '我看下目录。' },
    ])
    expect(result.content).toBe('我看下目录。')
    expect(result.reasoning).toBe('先想想。')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { id: 'toolu_02', name: 'ListDirectory', input: { path: 'chapters' } },
    ])
  })

  it('maps max_tokens stop reason to length', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写了一半' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '写一章' }],
      tools: [],
    }, () => {})

    expect(result.finishReason).toBe('length')
  })

  it('surfaces HTTP error message and throws', async () => {
    const events: Array<{ type: string; message?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'bad-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, (event) => {
      if (event.type === 'error') {
        events.push({ type: 'error', message: event.message })
      }
    })
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('invalid x-api-key')
    expect(events).toEqual([{ type: 'error', message: 'invalid x-api-key' }])
  })

  it('surfaces in-stream error events and throws', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开头' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Overloaded')
  })
})

/** anthropic SSE 帧：`event:` 行 + `data:` 行（适配器只消费 data 行）。 */
function createAnthropicStream(events: Array<Record<string, unknown>>) {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')

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
