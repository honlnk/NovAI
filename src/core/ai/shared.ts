/**
 * 统一清洗用户填写的 baseUrl，避免请求路径拼接时出现多余斜杠。
 */
export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 开发环境通过 Vite 代理转发第三方模型请求，避免浏览器直连时的 CORS 限制。
 */
export function resolveApiUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (shouldUseDevProxy(normalizedBaseUrl)) {
    return `/api-proxy${normalizedPath}`
  }

  return `${normalizedBaseUrl}${normalizedPath}`
}

/**
 * 创建默认的 JSON 请求头，并附带 Bearer 鉴权。
 */
export function createJsonHeaders(apiKey: string, baseUrl?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? '')

  if (shouldUseDevProxy(normalizedBaseUrl)) {
    headers['x-target-base'] = normalizedBaseUrl
  }

  return headers
}

/**
 * 尝试把响应按 JSON 解析；如果服务返回的是纯文本错误页，则回退为字符串。
 */
export async function readJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  return response.text()
}

/**
 * 从常见的 OpenAI 兼容错误结构中提取可展示消息，不命中时回退到默认文案。
 */
export function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload
  }

  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object' &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return payload.error.message
  }

  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message
  }

  return fallback
}

function shouldUseDevProxy(baseUrl: string) {
  if (!baseUrl) {
    return false
  }

  return typeof window !== 'undefined' && import.meta.env.DEV
}
