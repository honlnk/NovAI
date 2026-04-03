/**
 * 统一清洗用户填写的 baseUrl，避免请求路径拼接时出现多余斜杠。
 */
export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 创建默认的 JSON 请求头，并附带 Bearer 鉴权。
 */
export function createJsonHeaders(apiKey: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  }
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
