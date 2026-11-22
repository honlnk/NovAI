// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetTimelineBackupForTest,
  _setTimelineBackupStoreForTest,
  buildTimelineDraftKey,
  flushTimelineBackup,
  scheduleTimelineBackup,
  setupTimelineBackupLifecycle,
  type PersistedTimelineDraftRecord,
  type TimelineBackupStore,
  type TimelineEventDraft,
} from './timeline-backup'

function draft(title: string): TimelineEventDraft {
  return {
    title,
    summary: '',
    storyTime: null,
    relativeTime: null,
    participants: [],
    plotIds: [],
    chapters: [],
    causedBy: [],
  }
}

function memoryStore(): TimelineBackupStore & { records: Map<string, PersistedTimelineDraftRecord> } {
  const records = new Map<string, PersistedTimelineDraftRecord>()
  return {
    records,
    put(key, record) {
      records.set(key, record)
    },
    delete(key) {
      records.delete(key)
    },
    listByProject(projectId) {
      return [...records.values()].filter((record) => record.projectId === projectId)
    },
  }
}

describe('timeline-backup 去抖与卸载前落盘', () => {
  let store: ReturnType<typeof memoryStore>

  beforeEach(() => {
    vi.useFakeTimers()
    store = memoryStore()
    _setTimelineBackupStoreForTest(store)
  })

  afterEach(() => {
    _resetTimelineBackupForTest()
    _setTimelineBackupStoreForTest(null)
    vi.useRealTimers()
  })

  it('去抖窗口内不落盘；flushTimelineBackup 立即落盘最新内容并取消定时器', () => {
    scheduleTimelineBackup('p1', 'EVT-a', { draft: draft('一'), baseVersion: 'v1' })
    scheduleTimelineBackup('p1', 'EVT-a', { draft: draft('二'), baseVersion: 'v1' })
    expect(store.records.size).toBe(0)

    flushTimelineBackup()
    expect(store.records.get(buildTimelineDraftKey('p1', 'EVT-a'))?.draft.title).toBe('二')

    // 定时器已取消：到期不会重复写
    store.records.clear()
    vi.advanceTimersByTime(2000)
    expect(store.records.size).toBe(0)
  })

  it('页面卸载事件（pagehide / beforeunload / visibilitychange）触发同步落盘；退订后不再响应', () => {
    const teardown = setupTimelineBackupLifecycle()

    scheduleTimelineBackup('p1', 'EVT-a', { draft: draft('刷新前输入'), baseVersion: 'v1' })
    window.dispatchEvent(new Event('beforeunload'))
    expect(store.records.get(buildTimelineDraftKey('p1', 'EVT-a'))?.draft.title).toBe('刷新前输入')

    scheduleTimelineBackup('p1', 'EVT-b', { draft: draft('关页前输入'), baseVersion: 'v1' })
    window.dispatchEvent(new Event('pagehide'))
    expect(store.records.has(buildTimelineDraftKey('p1', 'EVT-b'))).toBe(true)

    teardown()
    scheduleTimelineBackup('p1', 'EVT-c', { draft: draft('退订后'), baseVersion: 'v1' })
    window.dispatchEvent(new Event('pagehide'))
    expect(store.records.has(buildTimelineDraftKey('p1', 'EVT-c'))).toBe(false)
  })
})
