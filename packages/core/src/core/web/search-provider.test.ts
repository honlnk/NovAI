import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LINKSEEK_HOSTED_BASE_URL,
  resolveSearchProvider,
} from './search-provider'

/**
 * 四档 provider 契约测试（mock fetch 断言请求构造与响应映射）。
 * 契约依据：linkseek src/public-api/router.ts；Exa / Perplexity 照 dsh web-search-* provider。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('linkseek provider（hosted / selfhost）', () => {
  it('hosted 档默认走内置常量地址，并携带匿名 clientId 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      query: 'test',
      count: 1,
      results: [{ title: '示例', url: 'https://example.com/a', snippet: '片段' }],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({
      provider: 'linkseek-hosted',
      baseUrl: '',
      apiKey: '',
      webClientId: 'client-uuid-0001',
    })
    const outcome = await provider.search('测试查询')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${LINKSEEK_HOSTED_BASE_URL}/v1/search`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-NovAI-Client-Id']).toBe('client-uuid-0001')
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(init.body as string)).toEqual({ query: '测试查询', maxResults: 8 })
    expect(outcome.sources).toEqual([
      { title: '示例', url: 'https://example.com/a', snippet: '片段' },
    ])
  })

  it('selfhost 档带 Bearer Key，且可覆盖 baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({
      provider: 'linkseek-selfhost',
      baseUrl: 'https://my-linkseek.example.org',
      apiKey: 'wf_testkey',
    })
    await provider.search('q')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://my-linkseek.example.org/v1/search')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wf_testkey')
  })

  it('selfhost 档缺 baseUrl 时在解析阶段即给出配置错误', () => {
    expect(() =>
      resolveSearchProvider({
        provider: 'linkseek-selfhost',
        baseUrl: '  ',
        apiKey: '',
      }),
    ).toThrow('linkseek 服务地址未配置')
  })

  it('429 时透传服务端额度文案', async () => {
    const quotaMessage = '免费搜索额度已用完（每日 50 次），明天自动恢复。如需不限量搜索，请在设置中配置自部署 linkseek 或第三方搜索 API Key。'
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'QUOTA_EXCEEDED', message: quotaMessage },
    }, 429))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({ provider: 'linkseek-hosted', baseUrl: '', apiKey: '' })
    await expect(provider.search('q')).rejects.toThrow(quotaMessage)
  })

  it('fetch 以 render:auto 调用并透传 renderedBy 与 notice', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      finalUrl: 'https://example.com/final',
      statusCode: 200,
      content: '# 正文',
      truncated: false,
      renderedBy: 'browser',
      notice: '渲染升级提示',
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({ provider: 'linkseek-hosted', baseUrl: '', apiKey: '' })
    const outcome = await provider.fetch!('https://example.com/')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${LINKSEEK_HOSTED_BASE_URL}/v1/fetch`)
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/', render: 'auto' })
    expect(outcome.renderedBy).toBe('browser')
    expect(outcome.notice).toBe('渲染升级提示')
    expect(outcome.finalUrl).toBe('https://example.com/final')
  })
})

describe('exa provider', () => {
  it('构造 search 请求并取首个非空 highlight 作 snippet，无 highlight 的条目丢弃', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      results: [
        {
          title: '带摘要',
          url: 'https://example.com/1',
          publishedDate: '2026-09-01',
          highlights: ['', '  ', '有效摘要'],
        },
        { title: '无摘要', url: 'https://example.com/2', highlights: [] },
      ],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({ provider: 'exa', baseUrl: '', apiKey: 'exa-key' })
    const outcome = await provider.search('query')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.exa.ai/search')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer exa-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'query',
      type: 'auto',
      numResults: 8,
      contents: { highlights: { highlightsPerUrl: 1 } },
    })
    expect(outcome.sources).toEqual([
      { title: '带摘要', url: 'https://example.com/1', snippet: '有效摘要', publishedAt: '2026-09-01' },
    ])
  })

  it('无 fetch 能力（WebFetch 工具据此给出引导文案）', () => {
    const provider = resolveSearchProvider({ provider: 'exa', baseUrl: '', apiKey: 'k' })
    expect(provider.fetch).toBeUndefined()
  })
})

describe('perplexity provider', () => {
  it('sonar 请求：content 作答案、search_results 作来源', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '综合答案' } }],
      search_results: [
        { url: 'https://example.com/1', title: '来源一', snippet: '摘要', date: '2026-09-01' },
      ],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({ provider: 'perplexity', baseUrl: '', apiKey: 'pkey' })
    const outcome = await provider.search('query')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.ai/chat/completions')
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'sonar',
      messages: [{ role: 'user', content: 'query' }],
    })
    expect(outcome.content).toBe('综合答案')
    expect(outcome.sources).toEqual([
      { title: '来源一', url: 'https://example.com/1', snippet: '摘要', publishedAt: '2026-09-01' },
    ])
  })

  it('search_results 缺失时回退 citations（URL-only，title 用 hostname）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '' } }],
      citations: ['https://docs.example.com/page'],
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({ provider: 'perplexity', baseUrl: '', apiKey: 'pkey' })
    const outcome = await provider.search('query')

    expect(outcome.content).toBeUndefined()
    expect(outcome.sources).toEqual([
      { title: 'docs.example.com', url: 'https://docs.example.com/page', snippet: '', publishedAt: undefined },
    ])
  })
})

describe('网络失败', () => {
  it('服务不可达时错误信息包含服务地址', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = resolveSearchProvider({
      provider: 'linkseek-selfhost',
      baseUrl: 'https://down.example.com',
      apiKey: '',
    })
    await expect(provider.search('q')).rejects.toThrow('https://down.example.com')
  })
})
