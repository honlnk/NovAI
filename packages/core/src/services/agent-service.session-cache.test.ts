import { beforeEach, describe, expect, it } from 'vitest'

import {
  cacheSession,
  evictProjectSessions,
  _clearSessionCacheForTest,
  _getCachedSessionIdsForTest,
} from './agent-service'
import type { ChatSessionState } from '../types/chat'

/**
 * 纯内存测试：验证会话缓存的上限淘汰（LRU）与项目级清理，不触及文件系统与 LLM。
 * cacheSession 通过 Map 插入顺序实现 LRU：delete+set 把命中条目移到末尾（最近），
 * 超过 MAX_CACHED_SESSIONS（=16）时从头部（最旧）淘汰。
 */
describe('agent-service 会话缓存（LRU + 项目级清理）', () => {
  beforeEach(() => {
    _clearSessionCacheForTest()
  })

  it('cacheSession 写入即驻留，按写入顺序排列', () => {
    cacheSession(buildSession('s1', 'proj-a'))
    cacheSession(buildSession('s2', 'proj-a'))

    expect(_getCachedSessionIdsForTest()).toEqual(['s1', 's2'])
  })

  it('超过上限（16）时淘汰最旧条目', () => {
    // 写入 17 条，期望最早那条被淘汰，保留 16 条
    for (let i = 0; i < 17; i += 1) {
      cacheSession(buildSession(`s${i}`, 'proj-a'))
    }

    const ids = _getCachedSessionIdsForTest()
    expect(ids).toHaveLength(16)
    // s0 最先写入、从未再被访问，应被淘汰
    expect(ids).not.toContain('s0')
    expect(ids[0]).toBe('s1')
    expect(ids[15]).toBe('s16')
  })

  it('重新写入（命中）会把条目移到末尾，刷新 LRU 顺序', () => {
    cacheSession(buildSession('s1', 'proj-a'))
    cacheSession(buildSession('s2', 'proj-a'))
    cacheSession(buildSession('s3', 'proj-a'))

    // 把 s1 重新写入，它应移到末尾
    cacheSession(buildSession('s1', 'proj-a'))

    expect(_getCachedSessionIdsForTest()).toEqual(['s2', 's3', 's1'])
  })

  it('命中刷新使旧条目免于被淘汰', () => {
    // 写满 16 条，再把最早的 s0 刷新一次，再写入第 17 条
    for (let i = 0; i < 16; i += 1) {
      cacheSession(buildSession(`s${i}`, 'proj-a'))
    }
    cacheSession(buildSession('s0', 'proj-a')) // s0 移到末尾

    cacheSession(buildSession('s16', 'proj-a')) // 触发淘汰，最旧的现在是 s1

    const ids = _getCachedSessionIdsForTest()
    expect(ids).toHaveLength(16)
    expect(ids).toContain('s0') // 被 refresh 保护下来
    expect(ids).not.toContain('s1') // 变成最旧被淘汰
  })

  it('evictProjectSessions 移除指定项目的全部会话，保留其它项目', () => {
    cacheSession(buildSession('a1', 'proj-a'))
    cacheSession(buildSession('a2', 'proj-a'))
    cacheSession(buildSession('b1', 'proj-b'))

    evictProjectSessions('proj-a')

    const ids = _getCachedSessionIdsForTest()
    expect(ids).toEqual(['b1'])
  })

  it('evictProjectSessions 对不存在的项目不抛错', () => {
    cacheSession(buildSession('a1', 'proj-a'))
    expect(() => evictProjectSessions('proj-none')).not.toThrow()
    expect(_getCachedSessionIdsForTest()).toEqual(['a1'])
  })
})

function buildSession(sessionId: string, projectId: string): ChatSessionState {
  const now = new Date().toISOString()
  return {
    sessionId,
    projectId,
    messages: [],
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    title: '测试会话',
    createdAt: now,
    updatedAt: now,
  }
}
