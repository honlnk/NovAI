import { afterEach, describe, expect, it, vi } from 'vitest'

import { webFetchTool } from './web-fetch'
import type { ProjectSnapshot, SearchConfig } from '../../types/project'

/**
 * WebFetch 工具测试：url 校验、第三方后端引导文案、
 * 输出 50,000 字符截断、renderedBy / notice 透传。
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('validateInput', () => {
  it('接受 http/https URL 并 trim', () => {
    expect(webFetchTool.validateInput({ url: ' https://example.com/a ' })).toEqual({
      url: 'https://example.com/a',
    })
  })

  it('拒绝非字符串、空串与非 http 协议', () => {
    expect(() => webFetchTool.validateInput({})).toThrow('有效的 url')
    expect(() => webFetchTool.validateInput({ url: '' })).toThrow('有效的 url')
    expect(() => webFetchTool.validateInput({ url: 'ftp://example.com' })).toThrow('http/https')
  })
})

describe('run', () => {
  it('第三方（无抓取）后端给出引导文案（决策 11）', async () => {
    await expect(
      webFetchTool.run({ url: 'https://example.com' }, runtimeWith({ provider: 'exa', baseUrl: '', apiKey: 'k' })),
    ).rejects.toThrow('当前搜索来源不支持网页抓取')
  })

  it('正常抓取透传 renderedBy/notice/finalUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      finalUrl: 'https://example.com/final',
      statusCode: 200,
      content: '# 标题\n\n正文',
      truncated: false,
      renderedBy: 'browser',
      notice: '已自动升级渲染',
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const output = await webFetchTool.run({ url: 'https://example.com' }, runtimeWith(hostedSearch))

    expect(output.finalUrl).toBe('https://example.com/final')
    expect(output.renderedBy).toBe('browser')
    expect(output.notice).toBe('已自动升级渲染')
    expect(output.truncated).toBe(false)
    expect(webFetchTool.summarizeOutput(output)).toContain('浏览器渲染')
  })

  it('正文超过 50,000 字符时截断并附提示', async () => {
    const longContent = 'x'.repeat(60_000)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      content: longContent,
      truncated: false,
      renderedBy: 'http',
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const output = await webFetchTool.run({ url: 'https://example.com/long' }, runtimeWith(hostedSearch))

    expect(output.content.length).toBeLessThan(longContent.length)
    expect(output.content).toContain('内容已截断至 50,000 字符')
    expect(output.truncated).toBe(true)
  })
})
