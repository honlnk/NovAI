import { resolveSearchProvider } from '../web/search-provider'
import type {
  ToolDefinition,
  WebFetchInput,
  WebFetchOutput,
} from './types'

/** 工具层输出上限（决策 8：50,000 字符，对齐 ReadFile 字节闸量级） */
const MAX_OUTPUT_CHARS = 50_000

/** 第三方（无抓取）后端使用 WebFetch 时的引导文案（决策 11） */
const NO_FETCH_PROVIDER_MESSAGE =
  '当前搜索来源不支持网页抓取。可在设置中配置自部署 linkseek 实例后使用该能力。'

export const webFetchTool: ToolDefinition<'WebFetch', WebFetchInput, WebFetchOutput> = {
  name: 'WebFetch',
  description: '抓取指定 URL 的网页正文（Markdown 格式），用于阅读 WebSearch 结果或用户给出的链接全文。服务端对反爬页面自动升级浏览器渲染。',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.url !== 'string' || !value.url.trim()) {
      throw new Error('WebFetch 需要有效的 url')
    }

    const url = value.url.trim()
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('WebFetch 的 url 必须是 http/https 地址')
    }

    return { url }
  },
  async run(input, runtime) {
    const provider = resolveSearchProvider({
      ...runtime.project.config.search,
      webClientId: runtime.webClientId,
    })

    if (!provider.fetch) {
      throw new Error(NO_FETCH_PROVIDER_MESSAGE)
    }

    const outcome = await provider.fetch(input.url)
    const truncatedByTool = outcome.content.length > MAX_OUTPUT_CHARS
    const content = truncatedByTool
      ? `${outcome.content.slice(0, MAX_OUTPUT_CHARS)}\n\n（内容已截断至 50,000 字符。如需后半部分，请抓取更具体的 URL 或章节锚点。）`
      : outcome.content

    return {
      url: input.url,
      finalUrl: outcome.finalUrl,
      statusCode: outcome.statusCode,
      content,
      truncated: outcome.truncated || truncatedByTool,
      renderedBy: outcome.renderedBy,
      notice: outcome.notice,
    }
  },
  summarizeInput(input) {
    return `网页抓取：${input.url}`
  },
  summarizeOutput(output) {
    const rendered = output.renderedBy === 'browser' ? '（浏览器渲染）' : ''
    return `WebFetch 抓取 ${output.finalUrl ?? output.url}${rendered}，${output.content.length} 字符${output.truncated ? '（已截断）' : ''}`
  },
}

function asObject(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}
