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

  it('maps reasoning effort to thinking wire params (D2 table): default omits, off disables, low/high/max budget', async () => {
    // 每次调用新流（Response body 单次消费）
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(createAnthropicStream([
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好。' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])))
    globalThis.fetch = fetchMock

    const efforts = ['low', 'high', 'max'] as const
    for (const effort of efforts) {
      await streamAgentCompletion({
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        reasoningEffort: effort,
      }, () => {})
    }
    await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      reasoningEffort: 'off',
    }, () => {})
    await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
    // low → budget 2048（默认 max_tokens 8192 已大于预算，不抬高）
    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(bodies[0].max_tokens).toBe(8192)
    // high → budget 8192 与默认上限相等：抬高 max_tokens 为预算 + 4096（真 Anthropic 要求严格大于）
    expect(bodies[1].thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(bodies[1].max_tokens).toBe(8192 + 4096)
    // max → budget 16384
    expect(bodies[2].thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
    expect(bodies[2].max_tokens).toBe(16384 + 4096)
    // off → 显式关闭
    expect(bodies[3].thinking).toEqual({ type: 'disabled' })
    expect(bodies[3].max_tokens).toBe(8192)
    // 缺省（未配置）→ 按 off 解析：显式 disabled（默认关闭）
    expect(bodies[4].thinking).toEqual({ type: 'disabled' })
    expect(bodies[4].max_tokens).toBe(8192)
  })

  it('replays reasoning as a leading thinking block with signature when present', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]))
    globalThis.fetch = fetchMock

    await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: '读章节' },
        {
          role: 'assistant',
          content: '',
          reasoning: '要调用 ReadFile。',
          thinkingSignature: 'sig-abc',
          toolCalls: [{ id: 'toolu_01', name: 'ListDirectory', input: { path: '' } }],
        },
        {
          role: 'assistant',
          content: '旧思考轮',
          reasoning: '没有签名的旧消息',
        },
      ],
      tools: [listDirectoryToolSchema],
    }, () => {})

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const first = body.messages.find((m: { role: string }) => m.role === 'assistant')
    // thinking block 居 content 首位（真 Anthropic 要求），带落盘签名
    expect(first.content[0]).toEqual({ type: 'thinking', thinking: '要调用 ReadFile。', signature: 'sig-abc' })
    // 无签名的思考轮：回传 thinking block 但不带 signature 字段
    const second = body.messages.filter((m: { role: string }) => m.role === 'assistant')[1]
    expect(second.content[0]).toEqual({ type: 'thinking', thinking: '没有签名的旧消息' })
  })

  it('collects thinkingSignature from signature_delta stream events', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createAnthropicStream([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想想。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-2' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案。' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]))
    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    expect(result.reasoning).toBe('先想想。')
    // 签名分段累积，与 reasoning 同为回传 thinking block 的原料
    expect(result.thinkingSignature).toBe('sig-part-1sig-part-2')
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
