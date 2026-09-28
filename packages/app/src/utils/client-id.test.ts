import { afterEach, describe, expect, it, vi } from 'vitest'

import { getOrCreateClientId } from './client-id'

/**
 * 匿名联网配额身份测试：生成/复用/持久化、非安全上下文兜底形态、localStorage 不可用降级。
 * 服务端 clientId 白名单字符集：^[A-Za-z0-9_-]{8,64}$。
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

function stubMemoryLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getOrCreateClientId', () => {
  it('首次调用生成并持久化 clientId，后续调用复用同一值', () => {
    const storage = stubMemoryLocalStorage()
    vi.stubGlobal('window', { localStorage: storage })
    vi.stubGlobal('crypto', { randomUUID: () => '550e8400-e29b-41d4-a716-446655440000' })

    const first = getOrCreateClientId()
    expect(first).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(getOrCreateClientId()).toBe(first)
  })

  it('无 crypto.randomUUID（非安全上下文）时用时间戳+随机数兜底，仍满足服务端字符集', () => {
    vi.stubGlobal('window', { localStorage: stubMemoryLocalStorage() })
    vi.stubGlobal('crypto', {})

    const id = getOrCreateClientId()
    expect(id).toBeTruthy()
    expect(id).toMatch(CLIENT_ID_PATTERN)
  })

  it('localStorage 不可用（隐私模式等）返回 undefined，退化为服务端按 IP 计数', () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('SecurityError')
      },
    })

    expect(getOrCreateClientId()).toBeUndefined()
  })
})
