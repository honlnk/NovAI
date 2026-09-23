const CLIENT_ID_STORAGE_KEY = 'novai.clientId'

/**
 * 获取（或首次生成并持久化）本浏览器安装的稳定 client id。
 *
 * 托管版 linkseek 绿灯配额没有账号体系，以此标识「同一用户」（服务端按
 * `cid:<clientId>` 每日加权计数）。localStorage 不可用（隐私模式等）时返回
 * undefined，服务端退化为按 IP 计数，不影响功能可用性。
 *
 * 非安全上下文（http 局域网访问）无 crypto.randomUUID，用时间戳 + 随机数兜底；
 * 两种形态均满足服务端 clientId 白名单字符集（[A-Za-z0-9_-]{8,64}）。
 */
export function getOrCreateClientId(): string | undefined {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY)
    if (existing) {
      return existing
    }

    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated)
    return generated
  } catch {
    return undefined
  }
}
