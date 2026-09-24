import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion } from '../../agent/llm'
import { resolveProtocolAdapter } from './resolve'
import type { AgentToolSchema } from '../../agent/messages'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('openai-responses adapter (via streamAgentCompletion)', () => {
  it('builds the wire request: instructions top-level, full-history input items, flattened function tools', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createResponsesStream([
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message' }] } },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '列出目录' },
        {
          role: 'assistant',
          content: '我来看一下。',
          toolCalls: [{ id: 'call_01', name: 'ListDirectory', input: { path: '' } }],
        },
        { role: 'tool', toolCallId: 'call_01', name: 'ListDirectory', content: 'chapter-001.txt' },
      ],
      tools: [listDirectoryToolSchema],
      maxTokens: 2048,
    }, () => {})

    expect(result.finishReason).toBe('stop')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })

    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-5.1')
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('你是小说创作 Agent。')
    expect(body.max_output_tokens).toBe(2048)
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列出目录' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来看一下。' }] },
      { type: 'function_call', call_id: 'call_01', name: 'ListDirectory', arguments: '{"path":""}' },
      { type: 'function_call_output', call_id: 'call_01', output: 'chapter-001.txt' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'ListDirectory',
        description: '列出目录',
        parameters: listDirectoryToolSchema.function.parameters,
      },
    ])
  })

  it('streams text/reasoning deltas and collects function calls from output_item.done', async () => {
    const events: Array<{ type: string; text?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(createResponsesStream([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', delta: '想一下 ' },
      { type: 'response.reasoning_summary_text.delta', delta: '怎么列目录' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
      { type: 'response.output_text.delta', delta: '我看下目录。' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_02', name: 'ListDirectory' } },
      { type: 'response.function_call_arguments.delta', delta: '{"path"' },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_02', name: 'ListDirectory', arguments: '{"path":"chapters"}' },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant' },
            { type: 'function_call', call_id: 'call_02', name: 'ListDirectory' },
          ],
        },
      },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: '列出 chapters' }],
      tools: [listDirectoryToolSchema],
    }, (event) => {
      if (event.type === 'delta' || event.type === 'reasoning-delta') {
        events.push({ type: event.type, text: event.text })
      }
    })

    expect(events).toEqual([
      { type: 'reasoning-delta', text: '想一下 ' },
      { type: 'reasoning-delta', text: '怎么列目录' },
      { type: 'delta', text: '我看下目录。' },
    ])
    expect(result.content).toBe('我看下目录。')
    expect(result.reasoning).toBe('想一下 怎么列目录')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { id: 'call_02', name: 'ListDirectory', input: { path: 'chapters' } },
    ])
  })

  it('maps response.incomplete to length', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createResponsesStream([
      { type: 'response.output_text.delta', delta: '写了一半' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: '写一章' }],
      tools: [],
    }, () => {})

    expect(result.content).toBe('写了一半')
    expect(result.finishReason).toBe('length')
  })

  it('throws on response.failed with the server message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createResponsesStream([
      { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } },
    ]))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Rate limit reached')
  })

  it('surfaces HTTP error message and throws', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided', type: 'invalid_request_error' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'bad-key',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Incorrect API key')
  })

  it('is reachable through resolveProtocolAdapter for all four protocols', () => {
    expect(resolveProtocolAdapter('openai').protocol).toBe('openai')
    expect(resolveProtocolAdapter('anthropic').protocol).toBe('anthropic')
    expect(resolveProtocolAdapter('gemini').protocol).toBe('gemini')
    expect(resolveProtocolAdapter('openai-responses').protocol).toBe('openai-responses')
  })

  it('maps reasoning effort to reasoning.effort (D2 table): low/high direct, max degrades to high, off/default omit', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(createResponsesStream([
        { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: '好的。' }] } },
        { type: 'response.completed', response: {} },
      ])))
    globalThis.fetch = fetchMock

    for (const effort of ['low', 'high', 'max', 'off'] as const) {
      await streamAgentCompletion({
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        reasoningEffort: effort,
      }, () => {})
    }
    await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
    expect(bodies[0].reasoning).toEqual({ effort: 'low' })
    expect(bodies[1].reasoning).toEqual({ effort: 'high' })
    // Responses 档位集合无 max：降级 high
    expect(bodies[2].reasoning).toEqual({ effort: 'high' })
    // Responses 无关闭思考参数（off 与缺省档——按 off 解析——均不传）
    expect(bodies[3]).not.toHaveProperty('reasoning')
    expect(bodies[4]).not.toHaveProperty('reasoning')
  })
})

/** Responses API SSE 流：每个 data 行一个事件对象，以 [DONE] 收尾。 */
function createResponsesStream(events: Array<Record<string, unknown>>) {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
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
