import { afterEach, describe, expect, it, vi } from 'vitest'

import { knowledgeLookupTool } from './knowledge-lookup'
import { renderKnowledgeUrl } from './knowledge-platforms'
import type { ProjectSnapshot, SearchConfig } from '../../types/project'

/**
 * KnowledgeLookup 工具测试：platform/term 校验、URL 模板渲染与中文编码、
 * 未命中判定（404 / 维基 Special: 停留）、透传与 50,000 字符截断、无抓取后端引导文案。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function runtimeWith(search: SearchConfig) {
  return {
    project: { config: { search } } as unknown as ProjectSnapshot,
  }
}

const hostedSearch: SearchConfig = {
  provider: 'linkseek-hosted',
  baseUrl: 'https://linkseek.test',
  apiKey: '',
}

const exaSearch: SearchConfig = {
  provider: 'exa',
  baseUrl: '',
  apiKey: 'exa-key',
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** 抓一次成功的条目：返回 (mock, 输出) */
async function lookupOnce(search: SearchConfig, input: { platform: string; term: string }, body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => jsonResponse(body))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const output = await knowledgeLookupTool.run(
    input as never,
    runtimeWith(search) as never,
  )
  return { fetchMock, output }
}

describe('validateInput', () => {
  it('接受已知平台与非空条目名并 trim', () => {
    expect(knowledgeLookupTool.validateInput({ platform: ' 维基百科 ', term: ' 岳飞 ' })).toEqual({
      platform: '维基百科',
      term: '岳飞',
    })
  })

  it('拒绝未知平台，错误信息列出全部可用平台', () => {
    expect(() => knowledgeLookupTool.validateInput({ platform: '知乎', term: '岳飞' })).toThrow(
      /未知平台「知乎」。可用平台：.*维基百科.*萌娘百科.*MDN/,
    )
  })

  it('拒绝空串与非字符串 term / platform', () => {
    expect(() => knowledgeLookupTool.validateInput({ platform: '维基百科', term: '' })).toThrow('非空的 term')
    expect(() => knowledgeLookupTool.validateInput({ platform: '维基百科', term: 42 })).toThrow('非空的 term')
    expect(() => knowledgeLookupTool.validateInput({ term: '岳飞' })).toThrow('有效的 platform')
  })
})

describe('URL 模板渲染', () => {
  it('维基系：条目名编码后拼入 Special:Search', () => {
    expect(renderKnowledgeUrl('https://zh.wikipedia.org/wiki/Special:Search?search={term}', '岳飞')).toBe(
      'https://zh.wikipedia.org/wiki/Special:Search?search=%E5%B2%B3%E9%A3%9E',
    )
  })

  it('百度百科：条目直链编码', async () => {
    const { fetchMock } = await lookupOnce(hostedSearch, { platform: '百度百科', term: '岳飞' }, {
      finalUrl: 'https://baike.baidu.com/item/%E5%B2%B3%E9%A3%9E',
      statusCode: 200,
      content: '岳飞（1103—1142）……',
    })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { url: string }
    expect(body.url).toBe('https://baike.baidu.com/item/%E5%B2%B3%E9%A3%9E')
  })

  it('MDN：斜杠路径保留、各段独立编码', async () => {
    const { fetchMock } = await lookupOnce(hostedSearch, { platform: 'MDN', term: 'Web/JavaScript Reference' }, {
      finalUrl: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript%20Reference',
      statusCode: 200,
      content: 'Array 参考文档……',
    })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { url: string }
    expect(body.url).toBe('https://developer.mozilla.org/zh-CN/docs/Web/JavaScript%20Reference')
  })
})

describe('未命中判定', () => {
  it('维基停在 Special: 搜索页 → found:false，content 为引导文案', async () => {
    const { output } = await lookupOnce(hostedSearch, { platform: '维基百科', term: '不存在的条目名' }, {
      finalUrl: 'https://zh.wikipedia.org/wiki/Special:%E6%90%9C%E7%B4%A2',
      statusCode: 200,
      content: '搜索结果页……',
    })
    expect(output.found).toBe(false)
    expect(output.content).toContain('未在维基百科命中条目「不存在的条目名」')
    expect(output.content).toContain('WebSearch')
  })

  it('HTTP 404 → found:false', async () => {
    const { output } = await lookupOnce(hostedSearch, { platform: '萌娘百科', term: '不存在' }, {
      finalUrl: 'https://zh.moegirl.org.cn/%E4%B8%8D%E5%AD%98%E5%9C%A8',
      statusCode: 404,
      content: '',
    })
    expect(output.found).toBe(false)
  })
})

describe('命中与透传', () => {
  it('found:true，content/renderedBy/notice 透传，finalUrl 为条目页', async () => {
    const { output } = await lookupOnce(hostedSearch, { platform: '维基文库', term: '岳陽樓記' }, {
      finalUrl: 'https://zh.wikisource.org/wiki/%E5%B2%B3%E9%99%BD%E6%A8%93%E8%A8%98',
      statusCode: 200,
      content: '慶曆四年春，滕子京謫守巴陵郡……',
      renderedBy: 'http',
      notice: undefined,
    })
    expect(output.found).toBe(true)
    expect(output.platform).toBe('维基文库')
    expect(output.term).toBe('岳陽樓記')
    expect(output.content).toContain('慶曆四年春')
    expect(output.renderedBy).toBe('http')
    expect(output.url).toBe('https://zh.wikisource.org/wiki/Special:Search?search=%E5%B2%B3%E9%99%BD%E6%A8%93%E8%A8%98')
  })

  it('超 50,000 字符截断并附提示', async () => {
    const { output } = await lookupOnce(hostedSearch, { platform: '维基百科', term: '岳飞' }, {
      finalUrl: 'https://zh.wikipedia.org/wiki/%E5%B2%B3%E9%A3%9E',
      statusCode: 200,
      content: '字'.repeat(60_000),
    })
    expect(output.found).toBe(true)
    expect(output.truncated).toBe(true)
    expect(output.content.length).toBeGreaterThan(50_000)
    expect(output.content.length).toBeLessThan(52_000)
    expect(output.content).toContain('（内容已截断至 50,000 字符')
  })
})

describe('后端能力门槛', () => {
  it('无抓取后端（exa）→ 抛「linkseek 直连」引导文案', async () => {
    await expect(
      knowledgeLookupTool.run({ platform: '维基百科', term: '岳飞' }, runtimeWith(exaSearch) as never),
    ).rejects.toThrow('当前搜索来源不支持网页抓取')
  })
})
