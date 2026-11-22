import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import {
  TimelineConflictError,
  checkLedger,
  cleanupInvalidEntries,
  createTimelinePointEvent,
  createTimelineSpanEvent,
  deleteTimelineEventEntry,
  getElementOptions,
  getTimeline,
  moveMarker,
  reinitializeLedger,
  subscribeTimelineChange,
  timelineEventVersion,
  updateTimelineEventEntry,
} from '@novai/core/services/timeline-service'
import type {
  TimelineChangeEvent,
  TimelineCheckIssue,
  TimelineElementOptionView,
  TimelineEventInput,
  TimelineMarkerView,
  TimelineView,
} from '@novai/core/services/timeline-service'
import type {
  NarrativeMode,
  RelativeTime,
  StoryTime,
  TimelineChapterRef,
  TimelineEvent,
  TimelineInsertPosition,
  TimelineMarker,
  TimelineParticipant,
} from '@novai/core/types/timeline'
import { createSaveSessionRealm } from '../composables/save-session'
import type { ChapterTimelineEventSummary } from '../constants/timeline'
import type {
  SaveSessionPhase,
  SaveSessionRestoreRecord,
  SaveSessionSettledResult,
} from '../composables/save-session'
import {
  type PersistedTimelineDraftRecord,
  type TimelineEventDraft,
  loadProjectTimelineBackups,
  removeTimelineBackup,
  scheduleTimelineBackup,
} from '../composables/timeline-backup'
import { elementRefKey, elementRefSelector } from '../utils/element-ref-key'
import type { GanttEntry } from './timeline-gantt'

/**
 * 时间线 store（时间线 JSON 化施工计划 §9.4）：对齐 relation store 的分层——
 * - 时间轴状态：账本视图（标记 + 三态引用解析）、等距横轴渲染模型（区间贪心分轨）、
 *   缩放（步距像素）与搜索/筛选（命中判定，不改变列表顺序）；
 * - 详情编辑：save-session 引擎按事件 id 建会话（两秒自动保存、冲突四出口、
 *   恢复镜像；保存只提交与基线相异的字段，冲突基线 = 单事件版本令牌）；
 * - 变更联动：订阅 timeline-service 变更通知，Agent 写入触发重载（保视口）并
 *   冻结被改动事件的待写会话；UI 自身写入不回环。
 */

export type TimelineLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'corrupt'

/** 新建事件表单（位置一律落尾部；界面暂不提供调整顺序，交 AI 移动） */
export type TimelineNewDraft = {
  kind: 'point' | 'span'
  title: string
  summary: string
}

/** 事件详情编辑会话（save-session 引擎领域字段） */
type TimelineDetailSession = {
  projectId: string
  eventId: string
  draft: TimelineEventDraft
  baseDraft: TimelineEventDraft
  /** 基线版本令牌 = timelineEventVersion（按条冲突口径，整本他处改动不误报） */
  baseVersion: string
  inFlight: unknown | null
  failure?: { message: string }
  conflict?: import('../composables/save-session').SaveSessionConflictState
  guard?: object
  restoredPending: boolean
  restoredAcked: boolean
  updatedAt: string
}

/** 磁盘版本：事件详情 + 这一条事件的版本令牌 */
type TimelineDisk = { event: TimelineEvent; version: string }

/* ---------- 纯函数：渲染模型（测试直测；甘特排布见 timeline-gantt.ts） ---------- */

/** 横轴上的一个标记位（一列）；甘特视图的条目由 ganttEntries 产出 */
export type TimelineAxisNode = {
  marker: TimelineMarker
  ordinal: number
  /** 携带详情的标记（point/start）才有；end 标记为 null */
  eventId: string | null
  title: string | null
  /** 明确时间展示文字（无则空串）；相对时间不上图，只在详情面板显示 */
  dateLabel: string
  /** 区间开始标记到结束标记的跨度（含两端）；非区间开始为 null */
  spanEndIndex: number | null
  /** 搜索/筛选命中（false 时轴上降透明度，不移除——顺序上下文是时间线的意义） */
  matched: boolean
}

export function formatStoryTime(time: StoryTime): string {
  const era = time.calendar ? `${time.calendar}·` : ''
  const parts = [time.season, time.month !== undefined ? `${time.month}月` : undefined, time.day !== undefined ? `${time.day}日` : undefined]
    .filter((part): part is string => Boolean(part))
  return `${era}${time.year}年${parts.length > 0 ? `（${parts.join('/')}）` : ''}`
}

export function formatRelativeTime(time: RelativeTime): string {
  return `${time.direction === 'before' ? '前' : '后'} ${time.offset} ${time.unit}`
}

/* ---------- 领域小工具 ---------- */

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function draftOf(event: TimelineEvent): TimelineEventDraft {
  return {
    title: event.title,
    summary: event.summary,
    storyTime: event.storyTime,
    relativeTime: event.relativeTime,
    participants: event.participants.map((participant) => ({ ...participant })),
    plotIds: [...event.plotIds],
    chapters: event.chapters.map((ref) => ({ ...ref })),
    causedBy: [...event.causedBy],
  }
}

function isSameDraft(a: TimelineEventDraft, b: TimelineEventDraft): boolean {
  return sameJson(a, b)
}

/** 空模板：恢复会话的基线快照（恢复草稿与之必然不同 → 会话带待写内容，自动保存续存） */
const EMPTY_DRAFT: TimelineEventDraft = {
  title: '',
  summary: '',
  storyTime: null,
  relativeTime: null,
  participants: [],
  plotIds: [],
  chapters: [],
  causedBy: [],
}

export const NARRATIVE_MODE_OPTIONS: { value: NarrativeMode; label: string }[] = [
  { value: 'current', label: '当前线' },
  { value: 'recall', label: '回忆' },
  { value: 'prophecy', label: '预言' },
  { value: 'dream', label: '梦境' },
]

export function narrativeModeLabel(mode: NarrativeMode): string {
  return NARRATIVE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

/** 与基线相异的字段才进提交补丁：未改的引用（含悬空）原样保留，不被重新解析卡死 */
function patchFromDraft(draft: TimelineEventDraft, base: TimelineEventDraft): TimelineEventInput {
  const patch: TimelineEventInput = {}
  if (draft.title !== base.title) {
    patch.title = draft.title
  }
  if (draft.summary !== base.summary) {
    patch.summary = draft.summary
  }
  if (!sameJson(draft.storyTime, base.storyTime)) {
    patch.storyTime = draft.storyTime
  }
  if (!sameJson(draft.relativeTime, base.relativeTime)) {
    patch.relativeTime = draft.relativeTime
  }
  if (!sameJson(draft.participants, base.participants)) {
    // 草稿里尚无标识的要素以 path: 键暂存，提交时转成路径选择器由服务层懒分配标识
    patch.participants = draft.participants.map((participant) => ({
      ...elementRefSelector(participant.id),
      ...(participant.role ? { role: participant.role } : {}),
    }))
  }
  if (!sameJson(draft.plotIds, base.plotIds)) {
    patch.plots = draft.plotIds.map((key) => elementRefSelector(key))
  }
  if (!sameJson(draft.chapters, base.chapters)) {
    patch.chapters = draft.chapters.map((ref) => ({ ...ref }))
  }
  if (!sameJson(draft.causedBy, base.causedBy)) {
    patch.causedBy = [...draft.causedBy]
  }
  return patch
}

export const useTimelineStore = defineStore('timeline', () => {
  /* ---------- 时间轴状态 ---------- */

  const projectId = ref('')
  const loadState = ref<TimelineLoadState>('idle')
  const actionError = ref('')
  const corruptRaw = ref('')
  const view = shallowRef<TimelineView | null>(null)

  /** 缩放 = 相邻标记的像素步距（48–240） */
  const stepPx = ref(96)

  const searchQuery = ref('')
  const filterKind = ref<'' | 'point' | 'span'>('')
  const filterParticipantId = ref('')
  const filterPlotId = ref('')
  const filterMode = ref<NarrativeMode | ''>('')

  const selectedEventId = ref('')

  /** 新建事件表单 */
  const createOpen = ref(false)
  const createDraft = reactive<TimelineNewDraft>({ kind: 'point', title: '', summary: '' })
  const createBusy = ref(false)

  /** 全量检查（检查面板按需触发，与账本加载隔离） */
  const checkIssues = ref<TimelineCheckIssue[]>([])
  const checkBusy = ref(false)

  const isLoading = computed(() => loadState.value === 'loading')
  const isReady = computed(() => loadState.value === 'ready')
  const isCorrupt = computed(() => loadState.value === 'corrupt')

  const markers = computed<TimelineMarkerView[]>(() => {
    const current = view.value
    if (!current || current.status !== 'ok') {
      return []
    }
    return current.markers
  })

  const eventCount = computed(() => markers.value.filter((item) => item.marker.kind !== 'end').length)
  const issueCount = computed(() => view.value?.issues.length ?? 0)

  /** 章节侧栏「本章相关事件」反查摘要：非结束标记的事件（id/标题/形态/关联章号）。 */
  const chapterEvents = computed<ChapterTimelineEventSummary[]>(() =>
    markers.value
      .map((item): ChapterTimelineEventSummary | null => {
        const marker = item.marker
        if (marker.kind === 'end') {
          return null
        }
        return {
          eventId: marker.eventId,
          title: marker.event.title,
          kind: marker.kind === 'start' ? 'span' : 'point',
          chapterNumbers: marker.event.chapters.map((ref) => ref.chapterNumber),
        }
      })
      .filter((summary): summary is ChapterTimelineEventSummary => summary !== null),
  )

  const hasFilter = computed(
    () =>
      searchQuery.value.trim() !== ''
      || filterKind.value !== ''
      || filterParticipantId.value !== ''
      || filterPlotId.value !== ''
      || filterMode.value !== '',
  )

  /** 搜索/筛选命中集合（eventId → 是否命中；无筛选时全命中） */
  const matchedEventIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    const query = searchQuery.value.trim().toLowerCase()
    for (const item of markers.value) {
      const marker = item.marker
      if (marker.kind === 'end') {
        continue
      }
      if (query && !marker.event.title.toLowerCase().includes(query) && !marker.event.summary.toLowerCase().includes(query)) {
        continue
      }
      if (filterKind.value === 'point' && marker.kind !== 'point') {
        continue
      }
      if (filterKind.value === 'span' && marker.kind !== 'start') {
        continue
      }
      if (filterParticipantId.value && !marker.event.participants.some((participant) => participant.id === filterParticipantId.value)) {
        continue
      }
      if (filterPlotId.value && !marker.event.plotIds.includes(filterPlotId.value)) {
        continue
      }
      if (filterMode.value && !marker.event.chapters.some((ref) => ref.mode === filterMode.value)) {
        continue
      }
      ids.add(marker.eventId)
    }
    return ids
  })

  /** 区间配对索引：start 标记下标 → 对应 end 标记下标（配对由账本加载保证） */
  const spanEndIndex = computed<Map<string, number>>(() => {
    const map = new Map<string, number>()
    const list = markers.value
    for (let index = 0; index < list.length; index += 1) {
      const marker = list[index]!.marker
      if (marker.kind !== 'end') {
        continue
      }
      const startIndex = list.findIndex((item) => item.marker.id === marker.startId)
      if (startIndex !== -1) {
        map.set(marker.startId, index)
      }
    }
    return map
  })

  /** 横轴列模型：全部合法标记各占一列（命中判定做透明度，不移除） */
  const axisNodes = computed<TimelineAxisNode[]>(() => {
    const matches = matchedEventIds.value
    const spans = spanEndIndex.value
    return markers.value.map((item) => {
      const marker = item.marker
      if (marker.kind === 'end') {
        // end 标记不可携带详情，只占列（甘特视图里就是区间横条的右端）
        return {
          marker,
          ordinal: item.ordinal,
          eventId: marker.eventId,
          title: null,
          dateLabel: '',
          spanEndIndex: null,
          matched: matches.size === 0 ? true : matches.has(marker.eventId),
        }
      }
      return {
        marker,
        ordinal: item.ordinal,
        eventId: marker.eventId,
        title: marker.event.title,
        // 只上图明确时间（甘特计划决策 8、9）：相对时间留在详情面板
        dateLabel: marker.event.storyTime ? formatStoryTime(marker.event.storyTime) : '',
        spanEndIndex: marker.kind === 'start' ? (spans.get(marker.id) ?? null) : null,
        matched: matches.size === 0 ? true : matches.has(marker.eventId),
      }
    })
  })

  /**
   * 甘特视图排布输入：每个携带详情的标记（point / start）一条。排布本身依赖文字测宽，
   * 在组件侧调用纯函数 layoutTimelineGantt 完成（store 不碰 DOM）。
   * 区间开始找不到配对结束时（账本加载已隔离，理论不出现）按单列处理，不丢事件。
   */
  const ganttEntries = computed<GanttEntry[]>(() =>
    axisNodes.value.flatMap((node, index): GanttEntry[] => {
      if (node.marker.kind === 'end' || node.eventId === null) {
        return []
      }
      const isSpan = node.marker.kind === 'start'
      return [{
        eventId: node.eventId,
        kind: isSpan ? 'span' : 'point',
        title: node.title ?? '',
        dateLabel: node.dateLabel,
        startIndex: index,
        endIndex: isSpan ? (node.spanEndIndex ?? index) : index,
        matched: node.matched,
      }]
    }),
  )

  /** 当前选中的事件视图（详情面板数据源：三态引用解析在这里） */
  const selectedMarkerView = computed<TimelineMarkerView | null>(
    () => markers.value.find((item) => item.marker.kind !== 'end' && item.marker.eventId === selectedEventId.value) ?? null,
  )

  /** 锚事件候选（相对时间锚 / 因果前驱选择器；排除自己） */
  const anchorEventOptions = computed(() =>
    markers.value
      .filter((item) => item.marker.kind !== 'end' && item.marker.eventId !== selectedEventId.value)
      .map((item) => ({
        eventId: item.marker.eventId,
        title: item.marker.kind === 'end' ? '' : item.marker.event.title,
      })),
  )

  /* ---------- 详情编辑会话（save-session 引擎） ---------- */

  async function probeTimeline(pid: string, eventId: string): Promise<
    { kind: 'ok'; disk: TimelineDisk } | { kind: 'missing' } | { kind: 'unreadable'; message: string }
  > {
    try {
      const current = await getTimeline(pid)
      if (current.status === 'corrupt') {
        return { kind: 'unreadable', message: '时间线账本已损坏，无法读取最新版本' }
      }
      const index = current.markers.findIndex((item) => item.marker.kind !== 'end' && item.marker.eventId === eventId)
      if (index === -1) {
        return { kind: 'missing' }
      }
      const found = current.markers[index]!
      if (found.marker.kind === 'end') {
        return { kind: 'missing' }
      }
      return { kind: 'ok', disk: { event: found.marker.event, version: timelineEventVersion(found.marker.event) } }
    } catch (error) {
      return { kind: 'unreadable', message: toMessage(error, '读取事件最新版本失败') }
    }
  }

  const detailRealm = createSaveSessionRealm<TimelineDetailSession, TimelineEventDraft, TimelineDisk>({
    isSameSnapshot: isSameDraft,
    getSnapshot: (session) => session.draft,
    setSnapshot: (session, snapshot) => {
      session.draft = snapshot
    },
    getBaseSnapshot: (session) => session.baseDraft,
    setBaseSnapshot: (session, snapshot) => {
      session.baseDraft = snapshot
    },
    getBaseVersion: (session) => session.baseVersion,
    setBaseVersion: (session, version) => {
      session.baseVersion = version
    },
    captureInFlight: (session) => {
      delete session.failure
      return true
    },
    releaseInFlight: (session) => {
      session.inFlight = null
    },
    createSession: (pid, eventId, seed) => ({
      projectId: pid,
      eventId,
      draft: seed.snapshot,
      baseDraft: seed.baseSnapshot,
      baseVersion: seed.baseVersion ?? '',
      inFlight: null,
      restoredPending: false,
      restoredAcked: false,
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
    }),
    upsertSession: (session, data) => {
      session.draft = data.snapshot
      session.baseDraft = data.baseSnapshot
    },
    save: async (pid, eventId, snapshot, ctx) => {
      // 恢复会话的基线是空模板，字段与之必然不同——那时全部字段按标识提交，
      // 服务层对「与基线引用相同的标识」同样不重新解析，悬空引用不受影响
      const patch = patchFromDraft(snapshot, ctx.base)
      if (Object.keys(patch).length === 0) {
        return { ok: true, disk: { event: draftLikeEvent(snapshot), version: '' } }
      }
      try {
        const result = await updateTimelineEventEntry(
          pid,
          {
            eventId,
            patch,
            // force（冲突出口「采用我的当前内容」）= 不带版本令牌直接写
            ...(ctx.force || ctx.baseVersion === undefined || ctx.baseVersion === ''
              ? {}
              : { expectedEventVersion: ctx.baseVersion }),
          },
          'ui',
        )
        return { ok: true, disk: { event: result.marker.kind === 'end' ? draftLikeEvent(snapshot) : result.marker.event, version: result.marker.kind === 'end' ? '' : timelineEventVersion(result.marker.event) } }
      } catch (error) {
        if (error instanceof TimelineConflictError) {
          const probe = await probeTimeline(pid, eventId)
          return {
            ok: false,
            conflict: true,
            message: error.message,
            ...(probe.kind === 'ok' ? { disk: probe.disk } : {}),
          }
        }
        return { ok: false, conflict: false, message: toMessage(error, '保存事件失败') }
      }
    },
    probe: (pid, eventId) => probeTimeline(pid, eventId),
    versionOf: (disk) => (disk.version === '' ? undefined : disk.version),
    snapshotFromDisk: (disk) => draftOf(disk.event),
    isBaselineIntact: (record, disk) => record.baseVersion === disk.version,
    isSnapshotOnDisk: (record, disk) => isSameDraft(record.snapshot, draftOf(disk.event)),
    scheduleMirror: (session) => {
      scheduleTimelineBackup(session.projectId, session.eventId, {
        draft: session.draft,
        baseVersion: session.baseVersion,
      })
    },
    removeMirror: (pid, eventId) => {
      removeTimelineBackup(pid, eventId)
    },
    onSettled: (pid, eventId, result) => handleDetailSettled(pid, eventId, result),
  })

  detailRealm.setAutosaveInputEnabled(true)

  /** 空补丁占位磁盘（快照与基线相同被引擎拦下，这里只是类型完备兜底） */
  function draftLikeEvent(draft: TimelineEventDraft): TimelineEvent {
    return {
      title: draft.title,
      summary: draft.summary,
      storyTime: draft.storyTime,
      relativeTime: draft.relativeTime,
      participants: draft.participants,
      plotIds: draft.plotIds,
      chapters: draft.chapters,
      causedBy: draft.causedBy,
      createdAt: '',
      updatedAt: '',
    }
  }

  async function handleDetailSettled(pid: string, eventId: string, result: SaveSessionSettledResult<TimelineDisk>): Promise<void> {
    if (pid !== projectId.value) {
      return
    }
    if (result.status === 'saved') {
      actionError.value = ''
      await reloadView({ preserveViewport: true })
    }
  }

  /** 打开某条事件的编辑会话（已存在则保留草稿；切换前先收口上一条） */
  async function openDetail(eventId: string) {
    const pid = projectId.value
    if (!pid) {
      return
    }
    if (selectedEventId.value && selectedEventId.value !== eventId) {
      await detailRealm.flushSession(pid, selectedEventId.value)
    }
    selectedEventId.value = eventId
    createOpen.value = false
    if (detailRealm.getSession(pid, eventId)) {
      return
    }
    const item = markers.value.find((entry) => entry.marker.kind !== 'end' && entry.marker.eventId === eventId)
    if (!item || item.marker.kind === 'end') {
      return
    }
    const draft = draftOf(item.marker.event)
    detailRealm.openSession(pid, eventId, {
      snapshot: draft,
      baseSnapshot: draft,
      baseVersion: timelineEventVersion(item.marker.event),
    })
  }

  /**
   * 视图重载后让会话跟上磁盘：干净会话直接重定基线到这条事件的最新版本；
   * 有待写内容的会话只在「这条事件本身被别处改过/删除」时冻结为冲突。
   */
  async function syncSessionsWithView(options: { freezeChanged: boolean }): Promise<void> {
    const pid = projectId.value
    const current = view.value
    if (!pid || !current || current.status !== 'ok') {
      return
    }
    for (const session of detailRealm.listSessions(pid)) {
      const index = current.markers.findIndex((item) => item.marker.kind !== 'end' && item.marker.eventId === session.eventId)
      if (index === -1) {
        if (detailRealm.isDirty(session) && options.freezeChanged) {
          await detailRealm.freezeForExternal(pid, session.eventId)
        }
        continue
      }
      const found = current.markers[index]!
      if (found.marker.kind === 'end') {
        continue
      }
      if (timelineEventVersion(found.marker.event) === session.baseVersion) {
        continue
      }
      if (detailRealm.isDirty(session)) {
        if (options.freezeChanged) {
          await detailRealm.freezeForExternal(pid, session.eventId)
        }
      } else {
        detailRealm.rebaseCleanBaseline(pid, session.eventId, { event: found.marker.event, version: timelineEventVersion(found.marker.event) })
      }
    }
  }

  /** 编辑输入（自动保存去抖在引擎内） */
  function setDetailDraft(eventId: string, patch: Partial<TimelineEventDraft>) {
    const session = detailRealm.getSession(projectId.value, eventId)
    if (!session) {
      return
    }
    detailRealm.setInput(projectId.value, eventId, { ...session.draft, ...patch })
  }

  /** 关闭当前详情（先收口待写内容） */
  async function closeDetail() {
    const pid = projectId.value
    if (selectedEventId.value) {
      await detailRealm.flushSession(pid, selectedEventId.value)
    }
    selectedEventId.value = ''
  }

  const detailSession = computed(() => detailRealm.getSession(projectId.value, selectedEventId.value))

  function detailPhase(session: TimelineDetailSession | undefined): SaveSessionPhase {
    return session ? detailRealm.phaseOf(session) : 'clean'
  }

  function retryDetailSave() {
    if (!selectedEventId.value) {
      return
    }
    void detailRealm.requestSave(projectId.value, selectedEventId.value, { trigger: 'manual' })
  }

  /** 冲突四出口：①采用磁盘版本（重新读取成功后放弃本地草稿） */
  async function adoptDiskVersion(): Promise<'resolved' | 'probe-failed' | 'aborted'> {
    const key = selectedEventId.value
    if (!key) {
      return 'probe-failed'
    }
    const outcome = await detailRealm.adoptDisk(projectId.value, key)
    if (outcome === 'resolved') {
      // 先重载再重开详情：openDetail 用当前视图播种草稿与基线版本，
      // 顺序反了会把「采用磁盘」播种成改盘前的旧基线，下次编辑保存必然再冲突
      await reloadView({ preserveViewport: true })
      await openDetail(key)
    }
    return outcome
  }

  /** 冲突四出口：②采用我的当前内容（强写覆盖，二次确认在界面层） */
  async function overwriteWithMine(): Promise<{ ok: boolean; message?: string }> {
    const key = selectedEventId.value
    if (!key) {
      return { ok: false, message: '当前没有选中的事件' }
    }
    const result = await detailRealm.overwriteContent(projectId.value, key)
    if (result.ok) {
      await reloadView({ preserveViewport: true })
    }
    return result
  }

  /** 冲突四出口：③返回继续编辑（收起比较，保留双方内容） */
  function collapseConflict() {
    if (selectedEventId.value) {
      detailRealm.collapseConflict(projectId.value, selectedEventId.value)
    }
  }

  /** 冲突四出口：④重新读取磁盘（比较区刷新到最新） */
  async function refreshConflict() {
    if (selectedEventId.value) {
      await detailRealm.expandConflict(projectId.value, selectedEventId.value)
    }
  }

  /* ---------- 时间轴读写 ---------- */

  let changeSubscription: (() => void) | null = null

  function handleChange(event: TimelineChangeEvent) {
    if (event.projectId !== projectId.value) {
      return
    }
    // UI 自身写入现场已同步，不回环；只响应 Agent 写入（重载 + 被改动事件的待写会话冻结）
    if (event.source !== 'agent') {
      return
    }
    void reloadView({ preserveViewport: true, freezeChangedSessions: true })
  }

  async function reloadView(options: { preserveViewport?: boolean; freezeChangedSessions?: boolean } = {}): Promise<void> {
    const pid = projectId.value
    if (!pid) {
      return
    }
    // 首载走 loading 态；Agent 写入触发的后台重载保持 ready，时间轴原地换新（不闪加载、不丢滚动位置）
    if (!view.value && loadState.value !== 'error') {
      loadState.value = 'loading'
    }
    try {
      const next = await getTimeline(pid)
      if (pid !== projectId.value) {
        return
      }
      if (next.status === 'corrupt') {
        loadState.value = 'corrupt'
        corruptRaw.value = next.raw ?? ''
        view.value = null
        return
      }
      corruptRaw.value = ''
      view.value = next
      loadState.value = 'ready'
      checkIssues.value = [] // 账本变化后旧检查结果作废，检查面板按需重跑
      // 引用级联后事件可能被删/被改：选中项失效时清掉选中
      if (selectedEventId.value && !next.markers.some((item) => item.marker.kind !== 'end' && item.marker.eventId === selectedEventId.value)) {
        selectedEventId.value = ''
      }
      actionError.value = ''
      await syncSessionsWithView({ freezeChanged: options.freezeChangedSessions === true })
    } catch (error) {
      if (pid !== projectId.value) {
        return
      }
      loadState.value = 'error'
      actionError.value = toMessage(error, '加载时间线失败')
    }
  }

  /** 打开时间线（进入时间轴弹窗时调用；恢复未落盘草稿的会话） */
  async function open(pid: string): Promise<void> {
    if (projectId.value !== pid) {
      projectId.value = pid
      loadState.value = 'idle'
      view.value = null
      selectedEventId.value = ''
      searchQuery.value = ''
      filterKind.value = ''
      filterParticipantId.value = ''
      filterPlotId.value = ''
      filterMode.value = ''
      checkIssues.value = []
      createOpen.value = false
    }
    if (!changeSubscription) {
      changeSubscription = subscribeTimelineChange(handleChange)
    }
    await reloadView()
    await restoreDetailSessions(pid)
  }

  /** 关闭时间线（收口全部编辑会话；订阅保留——Agent 写入仍需驱动下次打开时的最新视图） */
  async function close(): Promise<void> {
    const pid = projectId.value
    if (pid) {
      await detailRealm.flushSessions(pid)
    }
    createOpen.value = false
  }

  async function restoreDetailSessions(pid: string): Promise<void> {
    const records = loadProjectTimelineBackups(pid)
    if (records.length === 0) {
      return
    }
    const restoreRecords: SaveSessionRestoreRecord<TimelineEventDraft>[] = records.map((record: PersistedTimelineDraftRecord) => ({
      key: record.eventId,
      snapshot: { ...record.draft },
      baseSnapshot: { ...EMPTY_DRAFT },
      baseVersion: record.baseVersion,
      updatedAt: record.updatedAt,
    }))
    // 基线快照取磁盘版本（草稿与会话基线异构，恢复核对按版本令牌）
    await detailRealm.restoreSessions(pid, restoreRecords)
  }

  /* ---------- 写入动作（UI 入口） ---------- */

  /** 新建事件（点/区间；落尾部） */
  async function submitCreate(): Promise<boolean> {
    const pid = projectId.value
    const title = createDraft.title.trim()
    if (!pid || !title) {
      actionError.value = '事件标题必填'
      return false
    }
    createBusy.value = true
    try {
      const event: TimelineEventInput = { title, summary: createDraft.summary.trim() }
      const result = createDraft.kind === 'span'
        ? await createTimelineSpanEvent(pid, { event, startPosition: { at: 'last' }, endPosition: { at: 'last' } }, 'ui')
        : await createTimelinePointEvent(pid, { event, position: { at: 'last' } }, 'ui')
      actionError.value = ''
      createOpen.value = false
      createDraft.kind = 'point'
      createDraft.title = ''
      createDraft.summary = ''
      await reloadView({ preserveViewport: true })
      await openDetail(result.marker.eventId)
      return true
    } catch (error) {
      actionError.value = toMessage(error, '新建事件失败')
      return false
    } finally {
      createBusy.value = false
    }
  }

  function openCreateForm(): void {
    createOpen.value = true
    selectedEventId.value = ''
  }

  /**
   * 落位：把标记移到当前列表的第 targetIndex 个空隙（0..n）。
   * 甘特视图暂不允许用户拖动（甘特计划决策 6），当前无界面调用方；保留供日后接回调整入口。
   * 换算成锚点定位交给领域层（锚点语义在移除原位后的列表上解析，配对约束由领域重校验）。
   */
  async function moveMarkerToIndex(markerId: string, targetIndex: number): Promise<boolean> {
    const pid = projectId.value
    const current = view.value
    if (!pid || !current || current.status !== 'ok') {
      return false
    }
    const list = current.markers.map((item) => item.marker)
    const fromIndex = list.findIndex((marker) => marker.id === markerId)
    if (fromIndex === -1) {
      return false
    }
    const clamped = Math.max(0, Math.min(list.length, targetIndex))
    // 原位空隙（自己前面/后面紧邻的空隙）= 无操作
    if (clamped === fromIndex || clamped === fromIndex + 1) {
      return true
    }
    let position: TimelineInsertPosition
    if (clamped === 0) {
      position = { at: 'first' }
    } else if (clamped >= list.length) {
      position = { at: 'last' }
    } else {
      const anchor = list[clamped - 1]!
      if (anchor.id === markerId) {
        return true
      }
      position = { at: 'after', anchorMarkerId: anchor.id }
    }
    try {
      await moveMarker(pid, { markerId, position }, 'ui')
      actionError.value = ''
      await reloadView({ preserveViewport: true })
      return true
    } catch (error) {
      // 落位被领域拒绝（配对约束等）：磁盘未动，提示原因即可
      actionError.value = toMessage(error, '移动标记失败')
      return false
    }
  }

  /** 删除事件（删除确认在界面层；区间两端一起删） */
  async function removeEvent(eventId: string): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      detailRealm.clearSession(pid, eventId)
      await deleteTimelineEventEntry(pid, eventId, 'ui')
      if (selectedEventId.value === eventId) {
        selectedEventId.value = ''
      }
      actionError.value = ''
      await reloadView({ preserveViewport: true })
      return true
    } catch (error) {
      actionError.value = toMessage(error, '删除事件失败')
      return false
    }
  }

  /* ---------- 健康动作 ---------- */

  /** 一键清理异常条目（issue 状态下写入被阻止的出路） */
  async function cleanupIssues(): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      await cleanupInvalidEntries(pid, 'ui')
      actionError.value = ''
      await reloadView({ preserveViewport: true })
      return true
    } catch (error) {
      actionError.value = toMessage(error, '清理异常条目失败')
      return false
    }
  }

  /** 损坏态重置：副本入回收站后写空账本（确认在界面层） */
  async function reinitializeFromCorrupt(): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      await reinitializeLedger(pid, 'ui')
      corruptRaw.value = ''
      actionError.value = ''
      await reloadView()
      return true
    } catch (error) {
      actionError.value = toMessage(error, '重新初始化失败')
      return false
    }
  }

  /** 全量检查（隔离条目 + 悬空/歧义引用 + 章节可解析性 + 事件互引） */
  async function runCheck(): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    checkBusy.value = true
    try {
      const result = await checkLedger(pid)
      checkIssues.value = result.issues
      return true
    } catch (error) {
      actionError.value = toMessage(error, '时间线检查失败')
      return false
    } finally {
      checkBusy.value = false
    }
  }

  /* ---------- 选择器数据 ---------- */

  async function searchElementOptions(query: string, type?: import('@novai/core/types/rag').ElementType): Promise<TimelineElementOptionView[]> {
    return getElementOptions(projectId.value, query, type || undefined)
  }

  /** 选择器选中项的展示名缓存（要素 id → 名称；详情展示悬空引用之外的补充信息） */
  const optionLabels = reactive(new Map<string, string>())

  function rememberOption(option: TimelineElementOptionView): void {
    optionLabels.set(elementRefKey(option), option.name)
  }

  /** 要素 id → 展示名：视图解析结果 > 选择器缓存 > id 本身 */
  function elementLabelOf(id: string): string {
    const fromView = selectedMarkerView.value?.refs?.participants.find((entry) => entry.participant.id === id)?.view
    if (fromView && fromView.status === 'resolved') {
      return fromView.name
    }
    const plotView = selectedMarkerView.value?.refs?.plots.find((entry) => entry.id === id)?.view
    if (plotView && plotView.status === 'resolved') {
      return plotView.name
    }
    return optionLabels.get(id) ?? id
  }

  /* ---------- 测试注入口 ---------- */

  function _resetForTest(): void {
    if (changeSubscription) {
      changeSubscription()
      changeSubscription = null
    }
    projectId.value = ''
    loadState.value = 'idle'
    view.value = null
    actionError.value = ''
    corruptRaw.value = ''
    selectedEventId.value = ''
    searchQuery.value = ''
    filterKind.value = ''
    filterParticipantId.value = ''
    filterPlotId.value = ''
    filterMode.value = ''
    stepPx.value = 96
    checkIssues.value = []
    createOpen.value = false
    optionLabels.clear()
    detailRealm.resetForTest()
  }

  return {
    // 时间轴状态
    projectId,
    loadState,
    isLoading,
    isReady,
    isCorrupt,
    actionError,
    corruptRaw,
    view,
    markers,
    axisNodes,
    ganttEntries,
    eventCount,
    chapterEvents,
    issueCount,
    hasFilter,
    matchedEventIds,
    stepPx,
    searchQuery,
    filterKind,
    filterParticipantId,
    filterPlotId,
    filterMode,
    selectedEventId,
    selectedMarkerView,
    anchorEventOptions,
    // 生命周期
    open,
    close,
    reloadView,
    // 详情编辑
    detailSession,
    detailPhase,
    openDetail,
    setDetailDraft,
    closeDetail,
    retryDetailSave,
    adoptDiskVersion,
    overwriteWithMine,
    collapseConflict,
    refreshConflict,
    // 新建与整理
    createOpen,
    createDraft,
    createBusy,
    openCreateForm,
    submitCreate,
    moveMarkerToIndex,
    removeEvent,
    // 健康动作
    cleanupIssues,
    reinitializeFromCorrupt,
    runCheck,
    checkIssues,
    checkBusy,
    // 选择器数据
    searchElementOptions,
    rememberOption,
    elementLabelOf,
    // 测试
    _resetForTest,
    _detailRealm: detailRealm,
  }
})
