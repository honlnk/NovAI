import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion } from '../../agent/llm'
import type { AgentToolSchema } from '../../agent/messages'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('gemini adapter (via streamAgentCompletion)', () => {
  it('builds the wire request: systemInstruction, functionResponse parts, thoughtSignature replay, schema sanitization', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createGeminiStream([
      { candidates: [{ content: { role: 'model', parts: [{ text: '好的。' }] }, finishReason: 'STOP' }] },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: '你是小说创作 Agent。' },
        { role: 'user', content: '列出目录' },
        {
          role: 'assistant',
          content: '我来看一下。',
          toolCalls: [
            { id: 'call_01', name: 'ListDirectory', input: { path: '' }, thoughtSignature: 'sig-abc' },
          ],
        },
        { role: 'tool', toolCallId: 'call_01', name: 'ListDirectory', content: 'chapter-001.txt' },
      ],
      tools: [listDirectoryToolSchema],
      maxTokens: 1024,
    }, () => {})

    expect(result.content).toBe('好的。')
    expect(result.finishReason).toBe('stop')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(init.headers).toMatchObject({
      'x-goog-api-key': 'test-key',
      'Content-Type': 'application/json',
    })
    expect(init.headers).not.toHaveProperty('Authorization')

    const body = JSON.parse(init.body)
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是小说创作 Agent。' }] })
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } })
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: '列出目录' }] },
      {
        role: 'model',
        parts: [
          { text: '我来看一下。' },
          { functionCall: { name: 'ListDirectory', args: { path: '' } }, thoughtSignature: 'sig-abc' },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'ListDirectory', response: { result: 'chapter-001.txt' } } },
        ],
      },
    ])
    // 工具 schema 剥离 additionalProperties（gemini Schema 不认识），required 保留
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径' } },
      required: ['path'],
    })
    expect(JSON.stringify(body)).not.toContain('additionalProperties')
  })

  it('tolerates baseUrl with trailing /v1beta and omits tools when empty', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createGeminiStream([
      { candidates: [{ content: { role: 'model', parts: [{ text: '嗯。' }] }, finishReason: 'STOP' }] },
    ]))

    globalThis.fetch = fetchMock

    await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      apiKey: 'test-key',
      model: 'models/gemini-2.5-flash',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    // 模型名的 models/ 前缀剥离 + /v1beta 尾缀归一
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('tools')
    // 缺省档按 off 解析 → generationConfig 恒出现（仅含关闭思考的预算 0）
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
    expect(body).not.toHaveProperty('systemInstruction')
  })

  it('splits thought parts into reasoning and collects functionCall with thoughtSignature', async () => {
    const events: Array<{ type: string; text?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(createGeminiStream([
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: '先想想。', thought: true },
              { text: '我看下目录。' },
            ],
          },
        }],
      },
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'ListDirectory', args: { path: 'chapters' } }, thoughtSignature: 'sig-xyz' },
            ],
          },
          finishReason: 'STOP',
        }],
      },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '列出 chapters' }],
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
    // 有函数调用但 finishReason=STOP 时归一为 tool_calls（Agent 循环按此分支）
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { id: expect.stringMatching(/^tool_call_/), name: 'ListDirectory', input: { path: 'chapters' }, thoughtSignature: 'sig-xyz' },
    ])
  })

  it('maps MAX_TOKENS to length', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createGeminiStream([
      { candidates: [{ content: { role: 'model', parts: [{ text: '写了一半' }] }, finishReason: 'MAX_TOKENS' }] },
    ]))

    globalThis.fetch = fetchMock

    const result = await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '写一章' }],
      tools: [],
    }, () => {})

    expect(result.finishReason).toBe('length')
  })

  it('throws on safety-class finish reasons', async () => {
    const events: Array<{ type: string; message?: string }> = []
    const fetchMock = vi.fn().mockResolvedValueOnce(createGeminiStream([
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }] },
    ]))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '写一段' }],
      tools: [],
    }, (event) => {
      if (event.type === 'error') {
        events.push({ type: 'error', message: event.message })
      }
    })
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('SAFETY')
    expect(events).toHaveLength(1)
  })

  it('surfaces HTTP error message and throws', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    globalThis.fetch = fetchMock

    const promise = streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'bad-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})
    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('API key not valid')
  })

  it('maps reasoning effort to thinkingConfig.thinkingBudget (D2 table): off=0, low/high/max budgets, default omits', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(createGeminiStream([
        { candidates: [{ content: { role: 'model', parts: [{ text: '好的。' }] }, finishReason: 'STOP' }] },
      ])))
    globalThis.fetch = fetchMock

    const cases = [
      { effort: 'off' as const, budget: 0 },
      { effort: 'low' as const, budget: 2048 },
      { effort: 'high' as const, budget: 8192 },
      { effort: 'max' as const, budget: 32768 },
    ]
    for (const { effort } of cases) {
      await streamAgentCompletion({
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'test-key',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        reasoningEffort: effort,
      }, () => {})
    }
    await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
    }, () => {})

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
    for (const [index, { budget }] of cases.entries()) {
      expect(bodies[index].generationConfig.thinkingConfig).toEqual({ thinkingBudget: budget })
    }
    // 缺省（未配置）→ 按 off 解析：预算 0 显式关闭；无 maxTokens 时 generationConfig 只含思考配置
    expect(bodies[4].generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
  })
})

/** gemini SSE 流：每个 data 行是一个 GenerateContentResponse 块。 */
function createGeminiStream(chunks: Array<Record<string, unknown>>) {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
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
        path: { type: 'string', description: '相对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}
