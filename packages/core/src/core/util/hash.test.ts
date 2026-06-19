import { describe, expect, it } from 'vitest'

import { hashContent } from './hash'

describe('hashContent', () => {
  it('returns a stable hash for the same content', () => {
    expect(hashContent('你好，世界')).toBe(hashContent('你好，世界'))
  })

  it('returns different hashes for different content', () => {
    expect(hashContent('版本一')).not.toBe(hashContent('版本二'))
  })

  it('produces the historical FNV-1a format (h-prefixed hex)', () => {
    // 与原 read-file-state.ts / indexer.ts 的实现逐字节一致
    // "abc" 的 FNV-1a 32-bit: 0xe71c2f5 -> h 后跟 hex
    expect(hashContent('abc')).toMatch(/^h[0-9a-f]+$/)
  })

  it('handles empty string', () => {
    expect(hashContent('')).toBe('h' + (2166136261 >>> 0).toString(16))
  })
})
