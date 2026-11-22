import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { TimelineChangeEvent, TimelineView } from '@novai/core/services/timeline-service'
import type { TimelineMarkerView } from '@novai/core/services/timeline-service'
import type {
  TimelineEvent,
  TimelineMarker,
} from '@novai/core/types/timeline'

/* ---------- timeline-service 全量 mock（类型/错误类/版本函数保留真实实现） ---------- */

const changeListeners = new Set<(event: TimelineChangeEvent) => void>()

vi.mock('@novai/core/services/timeline-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/timeline-service')>()
  return {
    ...actual,
    getTimeline: vi.fn(),
    getElementOptions: vi.fn(),
    checkLedger: vi.fn(),
    createTimelinePointEvent: vi.fn(),
    createTimelineSpanEvent: vi.fn(),
    updateTimelineEventEntry: vi.fn(),
    moveMarker: vi.fn(),
    deleteTimelineEventEntry: vi.fn(),
    cleanupInvalidEntries: vi.fn(),
    reinitializeLedger: vi.fn(),
    subscribeTimelineChange: vi.fn((listener: (event: TimelineChangeEvent) => void) => {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    }),
  }
})

import {
  TimelineConflictError,
  timelineEventVersion,
  getTimeline,
  createTimelinePointEvent,
  createTimelineSpanEvent,
  updateTimelineEventEntry,
  moveMarker,
  deleteTimelineEventEntry,
} from '@novai/core/services/timeline-service'

/* ---------- 时间线草稿备份：内存存储 ---------- */

import {
  type PersistedTimelineDraftRecord,
  type TimelineBackupStore,
  _resetTimelineBackupForTest,
  _setTimelineBackupStoreForTest,
} from '../composables/timeline-backup'

const memoryStore = new Map<string, PersistedTimelineDraftRecord>()

_setTimelineBackupStoreForTest({
  put(key, record) {
    memoryStore.set(key, record)
  },
  delete(key) {
    memoryStore.delete(key)
  },
  listByProject(projectId) {
    return [...memoryStore.values()].filter((record) => record.projectId === projectId)
  },
} satisfies TimelineBackupStore)

import { allocateSpanLanes, useTimelineStore } from './timeline'

/* ---------- 测试数据 ---------- */

function event(eventId: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    title: `事件 ${eventId}`,
    summary: '',
    storyTime: null,
    relativeTime: null,
    participants: [],
    plotIds: [],
    chapters: [],
    causedBy: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const EVENT_A = 'EVT-aaaaaaaaaa'
const EVENT_B = 'EVT-bbbbbbbbbb'
const EVENT_C = 'EVT-cccccccccc'
const MARKER_A = 'TM-aaaaaaaaaa'
const MARKER_B_START = 'TM-bbbbbbbbb1'
const MARKER_B_END = 'TM-bbbbbbbbb2'
const MARKER_C = 'TM-cccccccccc'

const EVENT_A_DETAIL = event(EVENT_A, { title: '北境之战' })
const EVENT_B_DETAIL = event(EVENT_B, { title: '铁剑门兴起' })
const EVENT_C_DETAIL = event(EVENT_C, {
  title: '战前三日',
  relativeTime: { anchorEventId: EVENT_A, offset: 3, unit: '天', direction: 'before' },
  chapters: [{ chapterNumber: 1, mode: 'current' }],
})

/** 标记序列：A（点）→ B 开始 → C（点，B 区间内部）→ B 结束 */
function baseMarkers(): TimelineMarker[] {
  return [
    { id: MARKER_A, kind: 'point', eventId: EVENT_A, event: EVENT_A_DETAIL },
    { id: MARKER_B_START, kind: 'start', eventId: EVENT_B, event: EVENT_B_DETAIL },
    { id: MARKER_C, kind: 'point', eventId: EVENT_C, event: EVENT_C_DETAIL },
    { id: MARKER_B_END, kind: 'end', eventId: EVENT_B, startId: MARKER_B_START },
  ]
}

function markerViews(markers: TimelineMarker[]): TimelineMarkerView[] {
  return markers.map((marker, index) => ({ marker, ordinal: index + 1 }))
}

function timelineView(markers: TimelineMarker[] = baseMarkers(), overrides: Partial<TimelineView> = {}): TimelineView {
  return {
    status: 'ok',
    contentHash: 'hash-1',
    markers: markerViews(markers),
    issues: [],
    ...overrides,
  }
}

vi.mocked(getTimeline).mockResolvedValue(timelineView())

beforeEach(() => {
  vi.clearAllMocks()
  changeListeners.clear()
  memoryStore.clear()
  _resetTimelineBackupForTest()
  vi.mocked(getTimeline).mockResolvedValue(timelineView())
  vi.mocked(updateTimelineEventEntry).mockImplementation(async (_pid: string, options: { eventId: string; patch: import('@novai/core/services/timeline-service').TimelineEventInput }) => {
    const current = baseMarkers().find((marker): marker is Extract<TimelineMarker, { event: TimelineEvent }> => marker.kind !== 'end' && marker.eventId === options.eventId)
    const base = current ? current.event : event(options.eventId)
    // 补丁字段并回事件（服务层语义是「解析后的输入」，mock 只需返回合法事件）
    const patched = { ...base, ...options.patch } as TimelineEvent
    const next: TimelineMarker = current
      ? { ...current, event: patched }
      : { id: 'TM-mock000000', kind: 'point', eventId: options.eventId, event: patched }
    return { marker: next, previous: base, contentHash: 'hash-next', assignedElementIds: [] }
  })
  vi.mocked(createTimelinePointEvent).mockImplementation(async () => {
    const created: TimelineMarker = { id: 'TM-newpoint11', kind: 'point', eventId: 'EVT-newpoint11', event: event('EVT-newpoint11', { title: '新事件' }) }
    return { marker: created, contentHash: 'hash-new', assignedElementIds: [], created: false }
  })
  vi.mocked(createTimelineSpanEvent).mockImplementation(async () => {
    const created: TimelineMarker = { id: 'TM-newspan111', kind: 'start', eventId: 'EVT-newspan111', event: event('EVT-newspan111', { title: '新区间' }) }
    return { marker: created, endMarker: { id: 'TM-newspan112', kind: 'end', eventId: 'EVT-newspan111', startId: 'TM-newspan111' }, contentHash: 'hash-new', assignedElementIds: [], created: false }
  })
  vi.mocked(moveMarker).mockResolvedValue({ markers: baseMarkers(), contentHash: 'hash-moved' })
  vi.mocked(deleteTimelineEventEntry).mockResolvedValue({ removed: [], cascadedCausedBy: 0, contentHash: 'hash-deleted', removedEventRelations: 0, eventRelationCascadeError: '' })
  setActivePinia(createPinia())
})

afterEach(async () => {
  const store = useTimelineStore()
  store._resetForTest()
  vi.useRealTimers()
})

function emitChange(event: TimelineChangeEvent) {
  for (const listener of [...changeListeners]) {
    listener(event)
  }
}

/* ---------- 纯函数：轨道分配 ---------- */

describe('allocateSpanLanes（贪心分轨）', () => {
  it('无区间零轨道；不重叠的区间共用 lane 0', () => {
    expect(allocateSpanLanes([])).toEqual({ lanes: [], laneCount: 0 })
    const { lanes, laneCount } = allocateSpanLanes([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 2, endIndex: 3 },
    ])
    expect(lanes).toEqual([0, 0])
    expect(laneCount).toBe(1)
  })

  it('重叠区间分道：首个把下个挤到 lane 1，错开后回到 lane 0', () => {
    const { lanes, laneCount } = allocateSpanLanes([
      { startIndex: 0, endIndex: 3 },
      { startIndex: 1, endIndex: 2 },
      { startIndex: 4, endIndex: 5 },
    ])
    expect(lanes).toEqual([0, 1, 0])
    expect(laneCount).toBe(2)
  })

  it('紧邻（endIndex === 下个 startIndex）不算重叠', () => {
    const { lanes } = allocateSpanLanes([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 2, endIndex: 4 },
    ])
    expect(lanes).toEqual([0, 0])
  })
})

/* ---------- 时间轴渲染模型 ---------- */

describe('时间轴渲染模型', () => {
  it('open 加载视图：等距节点、区间跨点分轨、相对时间锚链、时间角标', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    expect(store.loadState).toBe('ready')
    expect(store.eventCount).toBe(3)
    expect(store.axisNodes).toHaveLength(4)
    expect(store.axisNodes.map((node) => node.ordinal)).toEqual([1, 2, 3, 4])
    // end 标记不携带详情（title null）但回指事件，可点选
    expect(store.axisNodes[3]!.title).toBeNull()
    expect(store.axisNodes[3]!.eventId).toBe(EVENT_B)

    // B 区间（下标 1 → 3）横带 + 独占 lane 0；C 在区间内部不产生横带
    expect(store.spanBands).toHaveLength(1)
    expect(store.spanBands[0]).toMatchObject({ eventId: EVENT_B, startIndex: 1, endIndex: 3, lane: 0 })
    expect(store.laneCount).toBe(1)

    // C 的相对时间锚链指向 A（下标 0 → 2）
    expect(store.anchorLinks).toEqual([{ fromIndex: 0, toIndex: 2, eventId: EVENT_C }])

    // C 有相对时间角标；A 无时间角标
    expect(store.axisNodes[2]!.timeLabel).toBe('前 3 天')
    expect(store.axisNodes[0]!.timeLabel).toBe('')
  })

  it('chapterEvents 章节反查摘要：id/标题/形态/关联章号（结束标记不产出条目）', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    // 夹具：A 无章节关联、B 区间、C 关联第 1 章
    expect(store.chapterEvents).toEqual([
      { eventId: EVENT_A, title: '北境之战', kind: 'point', chapterNumbers: [] },
      { eventId: EVENT_B, title: '铁剑门兴起', kind: 'span', chapterNumbers: [] },
      { eventId: EVENT_C, title: '战前三日', kind: 'point', chapterNumbers: [1] },
    ])
  })

  it('搜索/筛选命中做淡出不移除；无匹配保留全部位置', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    store.searchQuery = '北境'
    expect(store.hasFilter).toBe(true)
    expect(store.axisNodes.find((node) => node.eventId === EVENT_A)!.matched).toBe(true)
    expect(store.axisNodes.find((node) => node.eventId === EVENT_B)!.matched).toBe(false)
    expect(store.axisNodes).toHaveLength(4)
    expect(store.spanBands[0]!.dimmed).toBe(true)

    store.searchQuery = ''
    store.filterKind = 'span'
    expect(store.matchedEventIds).toEqual(new Set([EVENT_B]))
    store.filterKind = ''
    store.filterMode = 'current'
    expect(store.matchedEventIds).toEqual(new Set([EVENT_C]))
    store.filterMode = ''
    expect(store.hasFilter).toBe(false)
  })

  it('重载后选中事件被删：清空选中', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)
    expect(store.selectedEventId).toBe(EVENT_A)

    vi.mocked(getTimeline).mockResolvedValue(timelineView(baseMarkers().filter((marker) => marker.eventId !== EVENT_A)))
    await store.reloadView({ preserveViewport: true })
    expect(store.selectedEventId).toBe('')
  })
})

/* ---------- Agent 写入联动 ---------- */

describe('变更通知联动', () => {
  it('Agent 改动了正在编辑的事件：重载并冻结待写会话；UI 写入不回环', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    await store.openDetail(EVENT_A)
    store.setDetailDraft(EVENT_A, { title: '北境之战（改）' })
    expect(store.detailPhase(store.detailSession)).toBe('pending')

    const callsBefore = vi.mocked(getTimeline).mock.calls.length
    emitChange({ projectId: 'proj-1', source: 'ui', kind: 'events' })
    await Promise.resolve()
    expect(vi.mocked(getTimeline).mock.calls.length).toBe(callsBefore)

    vi.mocked(getTimeline).mockResolvedValue(
      timelineView(baseMarkers().map((marker) => (marker.kind !== 'end' && marker.eventId === EVENT_A ? { ...marker, event: event(EVENT_A, { title: 'Agent 改的标题', updatedAt: '2026-01-03T00:00:00.000Z' }) } : marker) as TimelineMarker)),
    )
    emitChange({ projectId: 'proj-1', source: 'agent', kind: 'events' })
    await vi.waitFor(() => expect(vi.mocked(getTimeline).mock.calls.length).toBeGreaterThan(callsBefore))
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())
    await vi.waitFor(() => expect(store.detailSession?.conflict?.probing).toBe(false))
  })

  it('其他项目的事件不触发本现场', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')
    const callsBefore = vi.mocked(getTimeline).mock.calls.length

    emitChange({ projectId: 'proj-other', source: 'agent', kind: 'events' })
    await Promise.resolve()
    expect(vi.mocked(getTimeline).mock.calls.length).toBe(callsBefore)
  })
})

/* ---------- 详情编辑会话 ---------- */

describe('详情编辑会话（save-session）', () => {
  it('打开详情建会话；输入走去抖自动保存，只提交与基线相异的字段', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')

    await store.openDetail(EVENT_A)
    const session = store.detailSession
    expect(session).toBeTruthy()
    expect(session!.baseVersion).toBe(timelineEventVersion(EVENT_A_DETAIL))

    store.setDetailDraft(EVENT_A, { title: '北境之战（改）', summary: '新增摘要' })
    expect(updateTimelineEventEntry).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(updateTimelineEventEntry).toHaveBeenCalledTimes(1))
    // 只有 title/summary 变了：其余字段（participants 等）不出现在补丁里（悬空引用不被重解析）
    expect(vi.mocked(updateTimelineEventEntry).mock.calls[0]![1].patch).toEqual({
      title: '北境之战（改）',
      summary: '新增摘要',
    })
    expect(vi.mocked(updateTimelineEventEntry).mock.calls[0]![1].expectedEventVersion).toBe(timelineEventVersion(EVENT_A_DETAIL))
  })

  it('尚无标识的要素以 path: 键入草稿，提交时转为路径选择器（不再传空标识）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)

    store.setDetailDraft(EVENT_A, {
      participants: [
        { kind: 'element', id: 'path:elements/characters/林远.md', role: '主角' },
        { kind: 'element', id: 'ELM-0000000001' },
      ],
      plotIds: ['path:elements/plots/离乡求道.md'],
    })
    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(updateTimelineEventEntry).toHaveBeenCalledTimes(1))
    const patch = vi.mocked(updateTimelineEventEntry).mock.calls[0]![1].patch
    expect(patch.participants).toEqual([
      { kind: 'element', sourcePath: 'elements/characters/林远.md', role: '主角' },
      { kind: 'element', id: 'ELM-0000000001' },
    ])
    expect(patch.plots).toEqual([{ kind: 'element', sourcePath: 'elements/plots/离乡求道.md' }])
  })

  it('版本冲突：会话冻结并携带磁盘版本；「返回编辑」收起比较', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)

    vi.mocked(updateTimelineEventEntry).mockRejectedValueOnce(new TimelineConflictError('hash-disk'))
    store.setDetailDraft(EVENT_A, { title: '改稿' })
    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())
    expect(store.detailPhase(store.detailSession)).toBe('conflict')

    expect(store.detailSession?.conflict?.disk).toMatchObject({
      event: expect.objectContaining({ title: '北境之战' }),
    })

    await store.collapseConflict()
    expect(store.detailSession?.conflict?.expanded).toBe(false)
  })

  it('采用磁盘版本：重载后重开详情，基线换成磁盘最新版本令牌', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)

    vi.mocked(updateTimelineEventEntry).mockRejectedValueOnce(new TimelineConflictError('hash-disk'))
    store.setDetailDraft(EVENT_A, { title: '改稿' })
    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())

    const diskEvent = event(EVENT_A, { title: '外部改盘后的标题', updatedAt: '2026-01-05T00:00:00.000Z' })
    vi.mocked(getTimeline).mockResolvedValue(
      timelineView(baseMarkers().map((marker) => (marker.kind !== 'end' && marker.eventId === EVENT_A ? { ...marker, event: diskEvent } : marker) as TimelineMarker)),
    )

    const outcome = await store.adoptDiskVersion()
    expect(outcome).toBe('resolved')
    expect(store.detailSession?.conflict).toBeFalsy()
    expect(store.detailSession?.draft.title).toBe('外部改盘后的标题')
    expect(store.detailSession?.baseVersion).toBe(timelineEventVersion(diskEvent))
  })

  it('外部修改命中干净会话：跟随磁盘；命中待写会话：冻结', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)

    const agentEdit = event(EVENT_A, { title: 'Agent 第一次改', updatedAt: '2026-01-03T00:00:00.000Z' })
    vi.mocked(getTimeline).mockResolvedValue(
      timelineView(baseMarkers().map((marker) => (marker.kind !== 'end' && marker.eventId === EVENT_A ? { ...marker, event: agentEdit } : marker) as TimelineMarker)),
    )
    emitChange({ projectId: 'proj-1', source: 'agent', kind: 'events' })
    await vi.waitFor(() => expect(store.detailSession?.draft.title).toBe('Agent 第一次改'))
    expect(store.detailSession?.conflict).toBeUndefined()
    expect(store.detailSession?.baseVersion).toBe(timelineEventVersion(agentEdit))
  })

  it('切选前收口上一条会话', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')

    await store.openDetail(EVENT_A)
    store.setDetailDraft(EVENT_A, { title: '待收口' })
    await store.openDetail(EVENT_B)
    expect(store.selectedEventId).toBe(EVENT_B)
    // openDetail 内 flushSession 把上一条立即落盘
    await vi.waitFor(() => expect(updateTimelineEventEntry).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateTimelineEventEntry).mock.calls[0]![0]).toBe('proj-1')
  })
})

/* ---------- 新建 / 移动 / 删除 ---------- */

describe('写入动作', () => {
  it('新建点事件：落尾部并打开详情', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    store.openCreateForm()
    store.createDraft.kind = 'point'
    store.createDraft.title = '新事件'
    store.createDraft.summary = '新摘要'
    const ok = await store.submitCreate()
    expect(ok).toBe(true)
    expect(createTimelinePointEvent).toHaveBeenCalledWith('proj-1', { event: { title: '新事件', summary: '新摘要' }, position: { at: 'last' } }, 'ui')
    expect(store.selectedEventId).toBe('EVT-newpoint11')
    expect(store.createOpen).toBe(false)
  })

  it('新建区间事件：起止都先落尾部', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    store.openCreateForm()
    store.createDraft.kind = 'span'
    store.createDraft.title = '新区间'
    const ok = await store.submitCreate()
    expect(ok).toBe(true)
    expect(createTimelineSpanEvent).toHaveBeenCalledWith('proj-1', { event: { title: '新区间', summary: '' }, startPosition: { at: 'last' }, endPosition: { at: 'last' } }, 'ui')
  })

  it('拖拽落位：空隙序号换算为锚点定位；原位空隙是无操作', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    // 把 B 开始（下标 1）移到空隙 3（C 之后）
    expect(await store.moveMarkerToIndex(MARKER_B_START, 3)).toBe(true)
    expect(moveMarker).toHaveBeenCalledWith('proj-1', { markerId: MARKER_B_START, position: { at: 'after', anchorMarkerId: MARKER_C } }, 'ui')

    // 空隙 0 → first（用非首位的 C，首位标记移到空隙 0 是无操作）；空隙 4（列表长度）→ last
    expect(await store.moveMarkerToIndex(MARKER_C, 0)).toBe(true)
    expect(moveMarker).toHaveBeenLastCalledWith('proj-1', { markerId: MARKER_C, position: { at: 'first' } }, 'ui')
    expect(await store.moveMarkerToIndex(MARKER_A, 4)).toBe(true)
    expect(moveMarker).toHaveBeenLastCalledWith('proj-1', { markerId: MARKER_A, position: { at: 'last' } }, 'ui')

    // 原位空隙（自己前/后紧邻）不触发写入
    vi.mocked(moveMarker).mockClear()
    expect(await store.moveMarkerToIndex(MARKER_B_START, 1)).toBe(true)
    expect(await store.moveMarkerToIndex(MARKER_B_START, 2)).toBe(true)
    expect(moveMarker).not.toHaveBeenCalled()
  })

  it('移动被领域拒绝（配对约束）：磁盘未动，提示原因', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')

    vi.mocked(moveMarker).mockRejectedValueOnce(new Error('移动 TM-xxx 会破坏区间配对：开始必须先于结束'))
    expect(await store.moveMarkerToIndex(MARKER_B_END, 0)).toBe(false)
    expect(store.actionError).toContain('破坏区间配对')
  })

  it('删除事件：清会话、写磁盘、清选中', async () => {
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)

    expect(await store.removeEvent(EVENT_A)).toBe(true)
    expect(deleteTimelineEventEntry).toHaveBeenCalledWith('proj-1', EVENT_A, 'ui')
    expect(store.selectedEventId).toBe('')
  })
})

/* ---------- 恢复镜像 ---------- */

describe('恢复镜像', () => {
  it('输入去抖进镜像：未落盘草稿携带版本令牌写入', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useTimelineStore()
    await store.open('proj-1')
    await store.openDetail(EVENT_A)
    store.setDetailDraft(EVENT_A, { title: '刷新前未落盘的标题' })
    vi.advanceTimersByTime(900)
    expect(memoryStore.size).toBe(1)
    const record = [...memoryStore.values()][0]!
    expect(record).toMatchObject({ projectId: 'proj-1', eventId: EVENT_A })
    expect(record.draft.title).toBe('刷新前未落盘的标题')
    expect(record.baseVersion).toBe(timelineEventVersion(EVENT_A_DETAIL))
  })

  it('浏览器刷新后未落盘草稿回填为待写会话并自动续存落盘', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // 直接播种持久化记录（模拟刷新后 localStorage 里的镜像；磁盘版本与基线一致）
    memoryStore.set('novai-timeline-draft:["proj-1","EVT-aaaaaaaaaa"]', {
      projectId: 'proj-1',
      eventId: EVENT_A,
      draft: {
        title: '刷新前未落盘的标题',
        summary: '',
        storyTime: null,
        relativeTime: null,
        participants: [],
        plotIds: [],
        chapters: [],
        causedBy: [],
      },
      baseVersion: timelineEventVersion(EVENT_A_DETAIL),
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const store = useTimelineStore()
    await store.open('proj-1')

    const session = store._detailRealm.getSession('proj-1', EVENT_A)
    expect(session).toBeTruthy()
    expect(session!.draft.title).toBe('刷新前未落盘的标题')
    expect(session!.restoredPending).toBe(true)
    expect(store._detailRealm.isDirty(session!)).toBe(true)

    // 基线一致 → 自动续存：恢复的待写内容随后自动落盘
    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(updateTimelineEventEntry).toHaveBeenCalled())
    expect(vi.mocked(updateTimelineEventEntry).mock.calls[0]![1].patch).toEqual({ title: '刷新前未落盘的标题' })
  })
})
