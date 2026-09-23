import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeSearchResults, webSearchTool } from './web-search'
import type { ProjectSnapshot, SearchConfig } from '../../types/project'

/**
 * WebSearch 工具测试：schema 校验边界、多 query 合并去重 cap、
 * 429 额度文案透传、webClientId 注入链路。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function runtimeWith(search: SearchConfig, webClientId?: string) {
  return {
    project: { config: { search } } as unknown as ProjectSnapshot,
    ...(webClientId ? { webClientId } : {}),
  }
}

const hostedSearch: SearchConfig = {
  provider: 'linkseek-hosted',
  baseUrl: 'https://linkseek.test',
  apiKey: '',
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('validateInput', () => {
  it('接受 1-4 条非空 query 并 trim', () => {
    expect(webSearchTool.validateInput({ queries: [' a ', 'b'] })).toEqual({ queries: ['a', 'b'] })
  })

  it('拒绝空数组、非数组、空字符串与超过 4 条', () => {
    expect(() => webSearchTool.validateInput({ queries: [] })).toThrow('非空')
    expect(() => webSearchTool.validateInput({ queries: 'a' })).toThrow('数组')
    expect(() => webSearchTool.validateInput({ queries: [''] })).toThrow('非空字符串')
    expect(() => webSearchTool.validateInput({ queries: ['a', 'b', 'c', 'd', 'e'] })).toThrow('最多 4 条')
  })
})

describe('mergeSearchResults', () => {
  it('多 query round-robin 交错 + URL 去重（fragment 差异视为同源）', () => {
    const merged = mergeSearchResults([
      { sources: [
        { title: 'q1a', url: 'https://a.com/1', snippet: '' },
        { title: 'q1b', url: 'https://a.com/2', snippet: '' },
      ] },
      { sources: [
        { title: 'q2a', url: 'https://a.com/1#x', snippet: '' },
        { title: 'q2b', url: 'https://b.com/1', snippet: '' },
      ] },
    ])

    expect(merged.sources.map((s) => s.title)).toEqual(['q1a', 'q1b', 'q2b'])
    expect(merged.truncated).toBe(false)
  })

  it('合并去重后超过 8 条时截断并置 truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      title: `t${i}`,
      url: `https://a.com/${i}`,
      snippet: '',
    }))
    const merged = mergeSearchResults([{ sources: many }])

    expect(merged.sources).toHaveLength(8)
    expect(merged.truncated).toBe(true)
  })
})

describe('run', () => {
  it('多 query 并发请求并合并；webClientId 经 X-NovAI-Client-Id 头注入', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        results: [{ title: '结果一', url: 'https://a.com/1', snippet: 's1' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ title: '结果二', url: 'https://b.com/1', snippet: 's2' }],
      }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const output = await webSearchTool.run(
      { queries: ['查询一', '查询二'] },
      runtimeWith(hostedSearch, 'client-uuid-42'),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>
      expect(headers['X-NovAI-Client-Id']).toBe('client-uuid-42')
    }
    expect(output.queries).toEqual(['查询一', '查询二'])
    expect(output.sources.map((s) => s.title)).toEqual(['结果一', '结果二'])
    expect(output.truncated).toBe(false)
  })

  it('任一 query 失败则整体失败；429 的服务端额度文案原样抛出', async () => {
    const quotaMessage = '免费搜索额度已用完（每日 50 次），明天自动恢复。如需不限量搜索，请在设置中配置自部署 linkseek 或第三方搜索 API Key。'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'QUOTA_EXCEEDED', message: quotaMessage } }, 429))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      webSearchTool.run({ queries: ['a', 'b'] }, runtimeWith(hostedSearch)),
    ).rejects.toThrow(quotaMessage)
  })

  it('无结果时返回空 sources（渲染层给出调整 query 的提示）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ query: 'q', count: 0, results: [], hint: '建议' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const output = await webSearchTool.run({ queries: ['无结果词'] }, runtimeWith(hostedSearch))
    expect(output.sources).toEqual([])
    expect(output.truncated).toBe(false)
    expect(webSearchTool.summarizeOutput(output)).toContain('无结果')
  })
})
