import { afterEach, describe, expect, it, vi } from 'vitest'

import { CompletionAbortedError, streamFimCompletion } from './completion-client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 构造一段 SSE 流式响应（legacy completions：choices[0].text）。 */
function createFimStreamingResponse(payloads: unknown[]) {
  const body =
    payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n'

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const BASE_INPUT = {
  baseUrl: 'https://api.deepseek.com/beta',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  prompt: '写第三章',
}

describe('streamFimCompletion - 基本流式解析', () => {
  it('读取 choices[0].text 作为增量（legacy completions 协议）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createFimStreamingResponse([
        { choices: [{ text: '，主角' }] },
        { choices: [{ text: '进入密境' }] },
      ]),
    )

    const deltas: string[] = []
    const result = await streamFimCompletion(BASE_INPUT, (event) => {
      if (event.type === 'delta') {
        deltas.push(event.text)
      }
    })

    expect(result).toBe('，主角进入密境')
    expect(deltas).toEqual(['，主角', '进入密境'])
  })

  it('兜底读取 choices[0].delta.content（应对代理网关改写为 chat 格式）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createFimStreamingResponse([
        { choices: [{ delta: { content: '继续' } }] },
        { choices: [{ delta: { content: '探索' } }] },
      ]),
    )

    const result = await streamFimCompletion(BASE_INPUT, () => {})

    expect(result).toBe('继续探索')
  })

  it('text 与 delta.content 同时存在时优先 text', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createFimStreamingResponse([
        { choices: [{ text: '用text', delta: { content: '用delta' } }] },
      ]),
    )

    const result = await streamFimCompletion(BASE_INPUT, () => {})

    expect(result).toBe('用text')
  })

  it('空配置抛错并发 error 事件', async () => {
    const events: string[] = []
    await expect(
      streamFimCompletion({ baseUrl: '', apiKey: '', model: '', prompt: 'x' }, (e) => {
        events.push(e.type)
      }),
    ).rejects.toThrow('请先填写补全模型的 API 地址')

    expect(events).toContain('error')
  })

  it('HTTP 错误抛错', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: '余额不足' } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(streamFimCompletion(BASE_INPUT, () => {})).rejects.toThrow('余额不足')
  })

  it('非流式兜底：response.body 为空时读取 choices[0].text', async () => {
    // 构造一个 body 为 null 的响应（某些代理可能返回非流式 JSON 且 body 已消费）
    const fakeResponse = {
      ok: true,
      body: null,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ choices: [{ text: '一次性返回' }] }),
      text: () => Promise.resolve(JSON.stringify({ choices: [{ text: '一次性返回' }] })),
    }
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse)

    const result = await streamFimCompletion(BASE_INPUT, () => {})

    expect(result).toBe('一次性返回')
  })
})

describe('streamFimCompletion - abort（用户中断）', () => {
  it('请求开始前已 abort，直接抛 CompletionAbortedError 且不发请求', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const controller = new AbortController()
    controller.abort()

    await expect(
      streamFimCompletion({ ...BASE_INPUT, signal: controller.signal }, () => {}),
    ).rejects.toBeInstanceOf(CompletionAbortedError)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('流式中途 abort，抛 CompletionAbortedError 并保留已生成内容', async () => {
    const userController = new AbortController()
    const encoder = new TextEncoder()

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(streamController) {
            // 先吐一个 chunk
            streamController.enqueue(
              encoder.encode('data: {"choices":[{"text":"前面这段"}]}\n\n'),
            )
            // 轮询等待 user abort，abort 后才 error 流（确保 signal.aborted 先为 true）
            for (let i = 0; i < 100; i++) {
              if (userController.signal.aborted) {
                streamController.error(new DOMException('Aborted', 'AbortError'))
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            streamController.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )

    const promise = streamFimCompletion(
      { ...BASE_INPUT, signal: userController.signal },
      () => {},
    )

    // 让第一个 chunk 被消费
    await new Promise((resolve) => setTimeout(resolve, 30))
    userController.abort()

    const error = await promise.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(CompletionAbortedError)
    expect((error as CompletionAbortedError).partialContent).toBe('前面这段')
  })

  it('空闲超时（15s 无 chunk）抛错', async () => {
    vi.useFakeTimers()

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>(), {
        // 永不 close 的空流
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    const promise = streamFimCompletion(BASE_INPUT, () => {})
    // 提前挂上 catch，避免超时 abort 产生的 rejection 成为 unhandled
    const errorPromise = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(16_000)

    const error = await errorPromise
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('空闲超过')
  })
})

describe('streamFimCompletion - 请求体', () => {
  it('使用 /completions 路径与 prompt/suffix/stop body', async () => {
    let capturedUrl = ''
    let capturedBody: unknown = null

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(createFimStreamingResponse([{ choices: [{ text: 'x' }] }]))
    })

    await streamFimCompletion(
      { ...BASE_INPUT, prompt: '前文', suffix: '后文', maxTokens: 32 },
      () => {},
    )

    expect(capturedUrl).toContain('/completions')
    expect(capturedBody).toMatchObject({
      model: 'deepseek-chat',
      prompt: '前文',
      suffix: '后文',
      stream: true,
      max_tokens: 32,
      stop: ['\n'],
    })
  })

  it('suffix 为空时传空串', async () => {
    let capturedBody: unknown = null
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(createFimStreamingResponse([{ choices: [{ text: 'x' }] }]))
    })

    await streamFimCompletion({ ...BASE_INPUT, prompt: '前文' }, () => {})

    expect(capturedBody).toMatchObject({ suffix: '' })
  })
})
