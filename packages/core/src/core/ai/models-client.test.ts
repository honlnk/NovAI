import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  filterModelsByPurpose,
  isDashScopeBaseUrl,
  listAvailableModels,
  testConnectionViaModelList,
} from './models-client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** 构造 OpenAI / Anthropic 风格的模型列表响应。 */
function createModelsResponse(models: string[]) {
  return new Response(
    JSON.stringify({ data: models.map((id) => ({ id })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** 构造 Gemini 原生风格的模型列表响应。 */
function createGeminiModelsResponse(models: string[]) {
  return new Response(
    JSON.stringify({ models: models.map((name) => ({ name: `models/${name}` })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('listAvailableModels - 请求构造与解析', () => {
  it('openai 协议：GET {base}/models，Bearer 鉴权，取 data[].id 去重排序', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createModelsResponse(['gpt-4o', 'deepseek-chat', 'gpt-4o']),
    )
    globalThis.fetch = fetchMock

    const result = await listAvailableModels({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    })

    expect(result.models).toEqual(['deepseek-chat', 'gpt-4o'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('openai-responses 协议：与 openai 共用 GET {base}/models，Bearer 鉴权', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createModelsResponse(['gpt-5.1', 'o4-mini']),
    )
    globalThis.fetch = fetchMock

    const result = await listAvailableModels({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      protocol: 'openai-responses',
    })

    expect(result.models).toEqual(['gpt-5.1', 'o4-mini'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai')
  })

  it('anthropic 协议：拼 /v1/models 且去掉 baseUrl 结尾的 /v1，用 x-api-key 鉴权', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createModelsResponse(['claude-sonnet-4']))
    globalThis.fetch = fetchMock

    await listAvailableModels({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      protocol: 'anthropic',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers.Authorization).toBeUndefined()
  })

  it('gemini 协议：拼 /v1beta/models，用 x-goog-api-key 鉴权，取 models[].name 去前缀', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createGeminiModelsResponse(['gemini-2.5-flash', 'gemini-2.5-pro']),
    )
    globalThis.fetch = fetchMock

    const result = await listAvailableModels({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'g-key',
      protocol: 'gemini',
    })

    expect(result.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key')
  })

  it('DashScope 原生地址自动改走 compatible-mode 拉取', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createModelsResponse(['qwen3-rerank']))
    globalThis.fetch = fetchMock

    await listAvailableModels({
      baseUrl: 'https://dashscope.aliyuncs.com',
      apiKey: 'sk-dashscope',
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models')
  })

  it('DashScope compatible-mode 地址不重复改写', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createModelsResponse(['text-embedding-v4']))
    globalThis.fetch = fetchMock

    await listAvailableModels({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-dashscope',
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models')
  })

  it('服务返回非 2xx 时抛出可读错误', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      listAvailableModels({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'bad' }),
    ).rejects.toThrow('Invalid API key')
  })

  it('缺少 baseUrl 或 apiKey 时直接报错，不发起请求', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock

    await expect(listAvailableModels({ baseUrl: '', apiKey: 'sk' })).rejects.toThrow('API 地址')
    await expect(
      listAvailableModels({ baseUrl: 'https://api.deepseek.com/v1', apiKey: ' ' }),
    ).rejects.toThrow('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('testConnectionViaModelList', () => {
  it('拉取成功且模型在列表中：ok 且 message 携带模型数量', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createModelsResponse(['deepseek-chat', 'deepseek-reasoner']))

    const result = await testConnectionViaModelList({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk',
      model: 'deepseek-chat',
      label: 'LLM',
      requiredMessage: '请先填写',
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 个模型')
  })

  it('模型名不在列表中：仍算成功，但 message 附确认提示', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createModelsResponse(['deepseek-chat']))

    const result = await testConnectionViaModelList({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk',
      model: 'not-exist-model',
      label: 'LLM',
      requiredMessage: '请先填写',
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('not-exist-model')
  })

  it('服务返回空列表：ok 且提示未返回列表', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(createModelsResponse([]))

    const result = await testConnectionViaModelList({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk',
      label: 'LLM',
      requiredMessage: '请先填写',
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('未返回模型列表')
  })

  it('缺少必填项：ok false 且不发起请求', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock

    const result = await testConnectionViaModelList({
      baseUrl: '',
      apiKey: '',
      label: 'LLM',
      requiredMessage: '请先填写 API 地址和 API Key',
    })

    expect(result).toEqual({ ok: false, message: '请先填写 API 地址和 API Key' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('网络失败：ok false 且透出错误信息', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await testConnectionViaModelList({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk',
      label: 'LLM',
      requiredMessage: '请先填写',
    })

    expect(result).toEqual({ ok: false, message: 'network down' })
  })
})

describe('filterModelsByPurpose', () => {
  const allModels = [
    'bge-m3',
    'deepseek-chat',
    'deepseek-reasoner',
    'e5-large',
    'gemini-2.5-flash',
    'gte-rerank-v2',
    'qwen3-rerank',
    'qwen-max',
    'qwen-vl-max',
    'text-embedding-v4',
    'whisper-large-v3',
  ]

  it('embedding：只保留向量化模型', () => {
    expect(filterModelsByPurpose(allModels, 'embedding')).toEqual([
      'bge-m3',
      'e5-large',
      'text-embedding-v4',
    ])
  })

  it('rerank：只保留重排序模型（含 qwen3-rerank 与 gte-rerank-v2）', () => {
    expect(filterModelsByPurpose(allModels, 'rerank')).toEqual([
      'gte-rerank-v2',
      'qwen3-rerank',
    ])
  })

  it('llm：排除 embedding / rerank / 语音 / 多模态模型', () => {
    expect(filterModelsByPurpose(allModels, 'llm')).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'gemini-2.5-flash',
      'qwen-max',
    ])
  })

  it('completion：不过滤，原样返回', () => {
    expect(filterModelsByPurpose(allModels, 'completion')).toEqual(allModels)
  })
})

describe('isDashScopeBaseUrl', () => {
  it('识别国内站与国际站，忽略其他地址', () => {
    expect(isDashScopeBaseUrl('https://dashscope.aliyuncs.com')).toBe(true)
    expect(isDashScopeBaseUrl('https://dashscope-intl.aliyuncs.com')).toBe(true)
    expect(isDashScopeBaseUrl('https://api.deepseek.com/v1')).toBe(false)
  })
})
