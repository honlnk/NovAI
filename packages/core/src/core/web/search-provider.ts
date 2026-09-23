import type { SearchConfig } from '../../types/project'

/**
 * 联网搜索后端抽象（照 dsh web capability seam 的形状裁剪）：
 * provider 只实现 search / fetch 能力，模型可见的工具 schema 恒定——换后端不动模型契约。
 *
 * 四档实现（决策 0006）：
 * - linkseek-hosted：官方托管实例，匿名绿灯（X-NovAI-Client-Id 头）+ 抓取带质量门控自动渲染
 * - linkseek-selfhost：用户自部署实例，Bearer Key 鉴权，同 REST 契约
 * - exa：Exa 搜索 API（POST /search，highlights 作 snippet），无抓取
 * - perplexity：Perplexity sonar（OpenAI 兼容 chat/completions），无抓取
 */

/**
 * linkseek 托管实例地址（官方生产域名，2026-09-24 上线时由占位值替换，
 * 见 docs/decisions/0006 与 docs/plans/内置联网搜索计划.md W2）。
 */
export const LINKSEEK_HOSTED_BASE_URL = 'https://linkseek.honlnk.com'

/** 托管档之外的默认服务地址（可被 config.search.baseUrl 覆盖） */
const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'
const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** 搜索超时（毫秒）；决策 8：搜索 30s。 */
const SEARCH_TIMEOUT_MS = 30_000
/** 抓取超时（毫秒）；决策 8：200s——盖过绿灯 render 上限 180s + 网络余量。 */
const FETCH_TIMEOUT_MS = 200_000

export type WebSearchSource = {
  title: string
  url: string
  snippet: string
  /** 发布时间（部分后端提供，供引用展示） */
  publishedAt?: string
}

export type WebSearchOutcome = {
  /** provider 生成的答案摘要（仅 perplexity 这类生成式后端有） */
  content?: string
  sources: WebSearchSource[]
}

export type WebFetchOutcome = {
  /** 重定向链终点 */
  finalUrl?: string
  /** 终点 HTTP 状态码（部分后端不提供） */
  statusCode?: number
  content: string
  truncated: boolean
  /** 'browser' = 服务端浏览器渲染（linkseek 质量门控自动升级）；缺省视为 http */
  renderedBy?: 'http' | 'browser'
  /** 服务端附带提示（如渲染升级失败的降级说明） */
  notice?: string
}

export type WebSearchProvider = {
  /** 单 query 搜索；失败抛 Error（消息面向模型，含额度文案时由服务端给出） */
  search(query: string): Promise<WebSearchOutcome>
  /** 抓取正文；无抓取能力的后端不实现（WebFetch 工具据此给出引导文案） */
  fetch?(url: string): Promise<WebFetchOutcome>
}

export type ResolveProviderInput = SearchConfig & {
  /** 匿名身份（仅托管档用；app 层生成的 localStorage UUID） */
  webClientId?: string
}

export function resolveSearchProvider(input: ResolveProviderInput): WebSearchProvider {
  switch (input.provider) {
    case 'linkseek-hosted':
      return createLinkseekProvider({
        baseUrl: input.baseUrl?.trim() || LINKSEEK_HOSTED_BASE_URL,
        apiKey: input.apiKey?.trim() || undefined,
        webClientId: input.webClientId,
      })
    case 'linkseek-selfhost':
      return createLinkseekProvider({
        baseUrl: input.baseUrl?.trim(),
        apiKey: input.apiKey?.trim() || undefined,
        webClientId: input.webClientId,
      })
    case 'exa':
      return createExaProvider({
        baseUrl: input.baseUrl?.trim() || EXA_DEFAULT_BASE_URL,
        apiKey: input.apiKey?.trim() || '',
      })
    case 'perplexity':
      return createPerplexityProvider({
        baseUrl: input.baseUrl?.trim() || PERPLEXITY_DEFAULT_BASE_URL,
        apiKey: input.apiKey?.trim() || '',
      })
  }
}

// ---------------------------------------------------------------------------
// linkseek REST 契约（见 linkseek 仓库 src/public-api/router.ts）
// ---------------------------------------------------------------------------

function createLinkseekProvider(options: {
  baseUrl: string
  apiKey?: string
  webClientId?: string
}): WebSearchProvider {
  if (!options.baseUrl) {
    throw new Error('linkseek 服务地址未配置：请在设置中填写自部署实例地址，或改用 NovAI 托管服务。')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  if (options.webClientId) headers['X-NovAI-Client-Id'] = options.webClientId

  async function callEndpoint<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${options.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`linkseek 请求超时（${timeoutMs / 1000}s）：${path}`)
      }
      throw new Error(`linkseek 服务不可达（${options.baseUrl}）：${errorMessage(error)}`)
    }

    if (!response.ok) {
      // 服务端错误体 { error: { code, message } }；429 的 message 是面向用户的额度文案，原样透传
      const message = await readErrorMessage(response)
      throw new Error(`linkseek 请求失败 [HTTP ${response.status}]：${message}`)
    }

    return response.json() as Promise<T>
  }

  return {
    async search(query) {
      const data = await callEndpoint<{ results?: Array<{ title?: string; url?: string; snippet?: string }> }>(
        '/v1/search',
        { query, maxResults: 8 },
        SEARCH_TIMEOUT_MS,
      )
      return {
        sources: (data.results ?? []).flatMap((item) => {
          if (!item.url || !item.title) return []
          return [{ title: item.title, url: item.url, snippet: item.snippet ?? '' }]
        }),
      }
    },
    async fetch(url) {
      const data = await callEndpoint<{
        finalUrl?: string
        statusCode?: number
        content?: string
        truncated?: boolean
        renderedBy?: 'http' | 'browser'
        notice?: string
      }>('/v1/fetch', { url, render: 'auto' }, FETCH_TIMEOUT_MS)
      return {
        finalUrl: data.finalUrl,
        statusCode: data.statusCode,
        content: data.content ?? '',
        truncated: Boolean(data.truncated),
        renderedBy: data.renderedBy,
        notice: data.notice,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Exa（契约照 dsh web-search-exa provider：POST /search + highlights）
// ---------------------------------------------------------------------------

function createExaProvider(options: { baseUrl: string; apiKey: string }): WebSearchProvider {
  return {
    async search(query) {
      const response = await postJson(
        `${options.baseUrl}/search`,
        {
          query,
          type: 'auto',
          numResults: 8,
          contents: { highlights: { highlightsPerUrl: 1 } },
        },
        { Authorization: `Bearer ${options.apiKey}` },
        SEARCH_TIMEOUT_MS,
        'Exa',
      )

      const data = (await response.json()) as {
        results?: Array<{
          title?: string
          url?: string
          publishedDate?: string
          highlights?: string[]
        }>
      }

      return {
        sources: (data.results ?? []).flatMap((item) => {
          const snippet = item.highlights?.find((text) => text.trim())
          // 无 highlight 的条目丢弃（照 dsh：snippet 空即无信息量）
          if (!item.url || !item.title || !snippet) return []
          return [{ title: item.title, url: item.url, snippet, publishedAt: item.publishedDate }]
        }),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Perplexity（契约照 dsh web-search-perplexity：sonar chat completions）
// ---------------------------------------------------------------------------

function createPerplexityProvider(options: { baseUrl: string; apiKey: string }): WebSearchProvider {
  return {
    async search(query) {
      const response = await postJson(
        `${options.baseUrl}/chat/completions`,
        {
          model: 'sonar',
          max_tokens: 1024,
          messages: [{ role: 'user', content: query }],
        },
        { Authorization: `Bearer ${options.apiKey}` },
        SEARCH_TIMEOUT_MS,
        'Perplexity',
      )

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        search_results?: Array<{ url?: string; title?: string; snippet?: string; date?: string }>
        citations?: string[]
      }

      const content = data.choices?.[0]?.message?.content?.trim() || undefined
      type ListedSource = { url?: string; title?: string; snippet?: string; date?: string }
      const listed: ListedSource[] = data.search_results?.length
        ? data.search_results
        : // search_results 缺失时回退 URL-only 的 citations（照 dsh）
          (data.citations ?? []).map((url) => ({ url }))

      return {
        content,
        sources: listed.flatMap((item) => {
          if (!item.url) return []
          return [{
            title: item.title ?? hostnameOf(item.url),
            url: item.url,
            snippet: item.snippet ?? '',
            publishedAt: item.date,
          }]
        }),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 共用 HTTP 工具
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  providerLabel: string,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`${providerLabel} 请求超时（${timeoutMs / 1000}s）`)
    }
    throw new Error(`${providerLabel} 服务不可达：${errorMessage(error)}`)
  }

  if (!response.ok) {
    const message = await readErrorMessage(response)
    throw new Error(`${providerLabel} 请求失败 [HTTP ${response.status}]：${message}`)
  }

  return response
}

/** 尽力从错误响应体提取 message；失败给通用文案 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string }
    return body.error?.message ?? body.message ?? '未知错误'
  } catch {
    return '未知错误'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
