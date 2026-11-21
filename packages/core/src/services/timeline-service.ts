import {
  TimelineConflictError,
  TimelineCorruptError,
  checkTimelineLedger,
  createTimelinePoint,
  createTimelineSpan,
  deleteTimelineEvent,
  loadTimelineLedger,
  moveTimelineMarker,
  queryTimelineEvents,
  removeInvalidTimelineEntries,
  removeTimelineReferences,
  removeTimelineReferencesByPath,
  updateTimelineEvent,
} from '../core/timeline/store'
import type {
  CreateTimelinePointOptions,
  CreateTimelineResult,
  CreateTimelineSpanOptions,
  DeleteTimelineEventResult,
  MoveTimelineMarkerOptions,
  MoveTimelineMarkerResult,
  TimelineCheckIssue,
  UpdateTimelineEventOptions,
  UpdateTimelineEventResult,
} from '../core/timeline/store'
import {
  buildElementReferenceIndex,
  resolveElementById,
  searchElementEntries,
} from '../core/elements/reference-index'
import { buildChapterCatalog } from '../core/chapters/catalog'
import { rescanProject, writeProjectTextFile } from '../core/fs/project-fs'
import { createTrashPath } from '../core/fs/trash'
import { writeJsonLedger } from '../core/ledger/json-ledger'
import type { ElementReferenceIndex } from '../core/elements/reference-index'

import { requireRuntimeProject } from './project-runtime'
import type { ProjectSnapshot } from '../types/project'
import type { ElementType } from '../types/rag'
import type { ChapterCatalog } from '../types/chapters'
import type {
  NarrativeMode,
  TimelineChapterRef,
  TimelineEvent,
  TimelineLedgerDocument,
  TimelineLedgerIssue,
  TimelineMarker,
  TimelineParticipant,
} from '../types/timeline'
import { TIMELINE_LEDGER_PATH, TIMELINE_LEDGER_VERSION } from '../types/timeline'

/**
 * 时间线服务层：UI 与六工具共用的唯一入口（校验、写锁与冲突规则只有一个事实来源）。
 *
 * - 视图把事件里的要素/章节/事件互引解析为「已解析 / 缺失 / 歧义」三态，
 *   时间轴与检查面板共用同一解析结果；relativeTime 锚事件删除后按缺失呈现（失效提示）。
 * - 所有写入成功后广播 TimelineChangeEvent，时间轴据此刷新（带来源标记，
 *   调用方用它跳过自身写入触发的自刷新）。
 */

/* ---------- 变更通知（模块级监听器，对齐 relation-service 模式） ---------- */

export type TimelineChangeEvent = {
  projectId: string
  /** 写入来源：ui = 时间轴弹窗，agent = 专用工具 */
  source: 'ui' | 'agent'
  kind: 'events' | 'cleanup' | 'reinitialize'
}

const timelineListeners = new Set<(event: TimelineChangeEvent) => void>()

export function subscribeTimelineChange(listener: (event: TimelineChangeEvent) => void): () => void {
  timelineListeners.add(listener)
  return () => {
    timelineListeners.delete(listener)
  }
}

function broadcastTimelineChange(event: TimelineChangeEvent): void {
  for (const listener of [...timelineListeners]) {
    try {
      listener(event)
    } catch {
      // 监听器异常不阻断广播
    }
  }
}

/* ---------- 视图类型 ---------- */

export type TimelineElementView =
  | { status: 'resolved'; id: string; type: ElementType; name: string; summary: string; sourcePath: string }
  | { status: 'missing'; id: string }
  | { status: 'ambiguous'; id: string; sourcePaths: string[] }

export type TimelineChapterView =
  | { status: 'chapter'; chapterNumber: number; mode: NarrativeMode; title: string; ref: string }
  | { status: 'missing'; chapterNumber: number; mode: NarrativeMode }
  | { status: 'ambiguous'; chapterNumber: number; mode: NarrativeMode; entries: { title: string; ref: string }[] }

/** 携带详情标记（point/start）的事件引用解析结果；end 标记不携带。 */
export type TimelineEventRefsView = {
  participants: { participant: TimelineParticipant; view: TimelineElementView }[]
  plots: { id: string; view: TimelineElementView }[]
  chapters: { ref: TimelineChapterRef; view: TimelineChapterView }[]
  /** 因果前驱：eventId → 事件标题（锚事件缺失时 title 为 null） */
  causedBy: { eventId: string; title: string | null }[]
  /** 相对时间锚事件；无相对时间或锚已删除（title null = 失效提示） */
  relativeAnchor: { eventId: string; title: string | null } | null
}

export type TimelineMarkerView = {
  marker: TimelineMarker
  /** 列表顺序序号（1 起，展示用；定位一律走标记标识） */
  ordinal: number
  refs?: TimelineEventRefsView
}

export type TimelineView = {
  status: 'ok' | 'corrupt'
  /** 账本基线内容哈希（编辑会话版本校验用）；文件不存在为 null */
  contentHash: string | null
  markers: TimelineMarkerView[]
  issues: TimelineLedgerIssue[]
  /** 损坏时的原始内容（只读呈现用） */
  raw?: string
}

/** 时间轴节点选择器的候选项（参与者/情节搜索用）：引用索引条目的直接映射。 */
export type TimelineElementOptionView = {
  id: string
  type: ElementType
  name: string
  summary: string
  sourcePath: string
}

/* ---------- 内部工具 ---------- */

async function freshSnapshot(projectId: string): Promise<ProjectSnapshot> {
  const project = requireRuntimeProject(projectId)
  const tree = await rescanProject(project)
  return { ...project, tree }
}

/** 要素引用 → 三态视图（resolved / missing / ambiguous，重复 id 不猜）。 */
function elementView(index: ElementReferenceIndex, id: string): TimelineElementView {
  const resolution = resolveElementById(index, id)
  if (resolution.status === 'resolved') {
    const entry = resolution.entry
    return { status: 'resolved', id, type: entry.type, name: entry.name, summary: entry.summary, sourcePath: entry.sourcePath }
  }
  if (resolution.status === 'ambiguous') {
    return { status: 'ambiguous', id, sourcePaths: resolution.sourcePaths }
  }
  return { status: 'missing', id }
}

/** 章节号引用 → 三态视图（同号多候选保留全部，不自动选择）。 */
function chapterView(catalog: ChapterCatalog, ref: TimelineChapterRef): TimelineChapterView {
  const entries = catalog.entries.filter((entry) => entry.number === ref.chapterNumber)
  if (entries.length === 0) {
    return { status: 'missing', chapterNumber: ref.chapterNumber, mode: ref.mode }
  }
  if (entries.length === 1) {
    return { status: 'chapter', chapterNumber: ref.chapterNumber, mode: ref.mode, title: entries[0].title, ref: entries[0].ref }
  }
  return {
    status: 'ambiguous',
    chapterNumber: ref.chapterNumber,
    mode: ref.mode,
    entries: entries.map((entry) => ({ title: entry.title, ref: entry.ref })),
  }
}

/* ---------- 读取 ---------- */

export async function getTimeline(projectId: string): Promise<TimelineView> {
  const project = requireRuntimeProject(projectId)

  let document
  try {
    document = await loadTimelineLedger(project)
  } catch (error) {
    if (error instanceof TimelineCorruptError) {
      return { status: 'corrupt', contentHash: null, markers: [], issues: [], raw: error.raw }
    }
    throw error
  }

  const snapshot = await freshSnapshot(projectId)
  return buildTimelineView(snapshot, document)
}

/** 把账本文档解析为视图（要素索引 + 章节目录 + 事件互引三路解析）。 */
export async function buildTimelineView(project: ProjectSnapshot, document: TimelineLedgerDocument): Promise<TimelineView> {
  const [index, catalog] = await Promise.all([
    buildElementReferenceIndex(project),
    Promise.resolve(buildChapterCatalog(project.tree)),
  ])
  return assembleView(document, index, catalog)
}

function assembleView(
  document: TimelineLedgerDocument,
  index: ElementReferenceIndex,
  catalog: ChapterCatalog,
): TimelineView {
  const eventTitles = new Map<string, string>()
  for (const marker of document.markers) {
    if (marker.kind !== 'end') {
      eventTitles.set(marker.eventId, marker.event.title)
    }
  }
  const markers: TimelineMarkerView[] = document.markers.map((marker, position) => ({
    marker,
    ordinal: position + 1,
    ...(marker.kind !== 'end' ? { refs: resolveEventRefs(marker.event, index, catalog, eventTitles) } : {}),
  }))
  return { status: 'ok', contentHash: document.contentHash, markers, issues: document.issues }
}

function resolveEventRefs(
  event: TimelineEvent,
  index: ElementReferenceIndex,
  catalog: ChapterCatalog,
  eventTitles: ReadonlyMap<string, string>,
): TimelineEventRefsView {
  const anchor = event.relativeTime
  return {
    participants: event.participants.map((participant) => ({ participant, view: elementView(index, participant.id) })),
    plots: event.plotIds.map((id) => ({ id, view: elementView(index, id) })),
    chapters: event.chapters.map((ref) => ({ ref, view: chapterView(catalog, ref) })),
    causedBy: event.causedBy.map((eventId) => ({ eventId, title: eventTitles.get(eventId) ?? null })),
    relativeAnchor: anchor
      ? { eventId: anchor.anchorEventId, title: eventTitles.get(anchor.anchorEventId) ?? null }
      : null,
  }
}

/* ---------- 写入（成功后广播变更） ---------- */

export async function createTimelinePointEvent(projectId: string, options: CreateTimelinePointOptions, source: 'ui' | 'agent' = 'ui'): Promise<CreateTimelineResult> {
  const project = requireRuntimeProject(projectId)
  const result = await createTimelinePoint(project, options)
  broadcastTimelineChange({ projectId, source, kind: 'events' })
  return result
}

export async function createTimelineSpanEvent(projectId: string, options: CreateTimelineSpanOptions, source: 'ui' | 'agent' = 'ui'): Promise<CreateTimelineResult> {
  const project = requireRuntimeProject(projectId)
  const result = await createTimelineSpan(project, options)
  broadcastTimelineChange({ projectId, source, kind: 'events' })
  return result
}

export async function updateTimelineEventEntry(projectId: string, options: UpdateTimelineEventOptions, source: 'ui' | 'agent' = 'ui'): Promise<UpdateTimelineEventResult> {
  const project = requireRuntimeProject(projectId)
  const result = await updateTimelineEvent(project, options)
  broadcastTimelineChange({ projectId, source, kind: 'events' })
  return result
}

export async function moveMarker(projectId: string, options: MoveTimelineMarkerOptions, source: 'ui' | 'agent' = 'ui'): Promise<MoveTimelineMarkerResult> {
  const project = requireRuntimeProject(projectId)
  const result = await moveTimelineMarker(project, options)
  broadcastTimelineChange({ projectId, source, kind: 'events' })
  return result
}

export async function deleteTimelineEventEntry(projectId: string, eventId: string, source: 'ui' | 'agent' = 'ui'): Promise<DeleteTimelineEventResult> {
  const project = requireRuntimeProject(projectId)
  const result = await deleteTimelineEvent(project, { eventId })
  broadcastTimelineChange({ projectId, source, kind: 'events' })
  return result
}

export async function cleanupInvalidEntries(projectId: string, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)
  const result = await removeInvalidTimelineEntries(project)
  broadcastTimelineChange({ projectId, source, kind: 'cleanup' })
  return result
}

/** 级联清理（要素删除链路）：按路径或标识清理参与者/情节引用。 */
export async function removeElementReferences(
  projectId: string,
  target: { sourcePath: string } | { elementId: string },
  source: 'ui' | 'agent' = 'agent',
) {
  const project = requireRuntimeProject(projectId)
  const result = 'sourcePath' in target
    ? await removeTimelineReferencesByPath(project, target.sourcePath)
    : await removeTimelineReferences(project, target.elementId)
  if (result.removedParticipants > 0 || result.removedPlotLinks > 0) {
    broadcastTimelineChange({ projectId, source, kind: 'events' })
  }
  return result
}

/**
 * 损坏重置（用户在时间轴中明确确认后调用）：原文件副本先入回收站，再写空账本。
 * 账本当前不处于损坏态时拒绝执行（防误触覆盖有效数据）。
 */
export async function reinitializeLedger(projectId: string, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)

  let corrupt: TimelineCorruptError | null = null
  try {
    await loadTimelineLedger(project)
  } catch (error) {
    if (error instanceof TimelineCorruptError) {
      corrupt = error
    } else {
      throw error
    }
  }
  if (!corrupt) {
    throw new Error('时间线账本当前可以正常读取，无需重新初始化；如需清空请逐条删除事件')
  }

  const trashPath = createTrashPath(TIMELINE_LEDGER_PATH)
  await writeProjectTextFile(project.handle, trashPath, corrupt.raw)
  await writeJsonLedger({
    project,
    path: TIMELINE_LEDGER_PATH,
    ledger: null,
    expectedContentHash: 'force',
    serialize: () => JSON.stringify({ version: TIMELINE_LEDGER_VERSION, markers: [] }, null, 2),
  })
  broadcastTimelineChange({ projectId, source, kind: 'reinitialize' })
  return { trashPath }
}

/* ---------- 查询与选项 ---------- */

/** 只读查询透传（TimelineList 工具与时间轴筛选共用领域实现）。 */
export { queryTimelineEvents }

/** 全量检查（时间轴检查入口共用领域实现）。 */
export async function checkLedger(projectId: string): Promise<{ issues: TimelineCheckIssue[] }> {
  const snapshot = await freshSnapshot(projectId)
  return checkTimelineLedger(snapshot)
}

/** 按名称子串搜索可引用的要素（参与者四类或情节）。 */
export async function getElementOptions(
  projectId: string,
  query: string,
  type?: ElementType,
): Promise<TimelineElementOptionView[]> {
  const snapshot = await freshSnapshot(projectId)
  const index = await buildElementReferenceIndex(snapshot)
  return searchElementEntries(index, query, type)
    .filter((entry) => entry.type !== 'timeline')
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      summary: entry.summary,
      sourcePath: entry.sourcePath,
    }))
}

/** 冲突错误类型再导出：UI 捕获后映射到保存会话冲突态。 */
export { TimelineConflictError, TimelineCorruptError }

/** 单事件版本令牌（UI 编辑会话按条做冲突判定）。 */
export { timelineEventVersion } from '../core/timeline/store'

/** 领域输入与检查类型再导出（app 只能经服务层访问 core，见架构边界）。 */
export type {
  TimelineCheckIssue,
  TimelineEventInput,
  TimelineElementSelector,
  TimelineParticipantInput,
} from '../core/timeline/store'
