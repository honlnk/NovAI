import {
  JsonLedgerConflictError,
  JsonLedgerCorruptError,
  readJsonLedger,
  writeJsonLedger,
} from '../ledger/json-ledger'
import {
  buildElementReferenceIndex,
  ensureElementId,
  resolveElementById,
  searchElementEntries,
} from '../elements/reference-index'
import { buildChapterCatalog } from '../chapters/catalog'
import { rescanProject } from '../fs/project-fs'
import { hashContent } from '../util/hash'

import type { ElementReferenceEntry, ElementReferenceIndex } from '../elements/reference-index'
import type { ProjectSnapshot } from '../../types/project'
import type { ElementType } from '../../types/rag'
import type {
  NarrativeMode,
  RelativeTime,
  StoryTime,
  TimelineChapterRef,
  TimelineEvent,
  TimelineInsertPosition,
  TimelineLedgerDocument,
  TimelineLedgerIssue,
  TimelineMarker,
  TimelineParticipant,
} from '../../types/timeline'
import {
  EVENT_ID_PATTERN,
  MARKER_ID_PATTERN,
  TIMELINE_LEDGER_PATH,
  TIMELINE_LEDGER_VERSION,
  TIMELINE_PARTICIPANT_TYPES,
} from '../../types/timeline'

/**
 * 时间线领域核心（时间线 JSON 化改造施工计划 §9.2）：账本读写、域内写锁、
 * 结构校验（形状 / 配对 / 顺序 / 标识唯一）与非法条目隔离。
 *
 * 列表顺序即故事内顺序，是一切定位与排序的基本依据；明确时间与相对时间只是
 * 补充描述，领域永不按 storyTime 重排列表。CRUD / 查询 / 级联在阶段 2 补齐。
 */

/** 领域错误（可修复的校验拒绝）。 */
export class TimelineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelineError'
  }
}

/** 写入版本冲突（磁盘与预期版本不一致），携带磁盘当前哈希供上层重读或上抛冲突界面。 */
export class TimelineConflictError extends TimelineError {
  readonly currentContentHash: string | null

  constructor(currentContentHash: string | null) {
    super(
      currentContentHash === null
        ? `时间线账本已不存在，本次操作基于的版本已过期；请重新读取后再试`
        : `时间线账本已被其他操作修改，本次操作基于的版本已过期；请重新读取后再试`,
    )
    this.name = 'TimelineConflictError'
    this.currentContentHash = currentContentHash
  }
}

/** 账本损坏：携带原始内容供界面只读呈现；恢复只能走「副本入回收站 + 重新初始化」。 */
export class TimelineCorruptError extends TimelineError {
  readonly raw: string

  constructor(raw: string, reason: string) {
    super(`时间线账本已损坏（${reason}），不会自动覆盖；请在时间轴弹窗中查看原始内容或重新初始化`)
    this.name = 'TimelineCorruptError'
    this.raw = raw
  }
}

/* ---------- 域内写锁：单项目所有账本写入串行（UI、工具共用一条链） ---------- */

const writeLocks = new Map<string, Promise<unknown>>()

async function withTimelineWriteLock<T>(project: ProjectSnapshot, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(project.id) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  writeLocks.set(project.id, next)
  try {
    return await next
  } finally {
    // 链上只剩自己时清掉引用，避免长期持有完成的 Promise
    if (writeLocks.get(project.id) === next) {
      writeLocks.delete(project.id)
    }
  }
}

/* ---------- 载入与序列化 ---------- */

/**
 * 读取时间线账本。文件不存在 → 空账本文档（contentHash = null，首次写入按新建语义，
 * 空账本不产生文件）；结构性损坏（JSON / 根结构 / 版本）→ TimelineCorruptError；
 * 单条非法数据不丢弃文件，隔离进 issues（结构写入被阻止直至清理）。
 */
export async function loadTimelineLedger(project: ProjectSnapshot): Promise<TimelineLedgerDocument> {
  let document: { ledger: { markers: TimelineMarker[]; issues: TimelineLedgerIssue[] }; contentHash: string } | null
  try {
    document = await readJsonLedger({
      project,
      path: TIMELINE_LEDGER_PATH,
      revive: reviveTimelineLedger,
    })
  } catch (error) {
    if (error instanceof JsonLedgerCorruptError) {
      throw new TimelineCorruptError(error.raw, error.reason)
    }
    throw error
  }

  if (!document) {
    return { markers: [], issues: [], contentHash: null }
  }

  return {
    markers: document.ledger.markers,
    issues: document.ledger.issues,
    contentHash: document.contentHash,
  }
}

/** revive：根结构 / 版本校验（抛错 = 损坏）+ 单条数据校验（非法条目隔离，不抛错不丢弃）。 */
function reviveTimelineLedger(raw: unknown): { markers: TimelineMarker[]; issues: TimelineLedgerIssue[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('根结构必须是对象')
  }

  const root = raw as Record<string, unknown>
  if (root.version !== TIMELINE_LEDGER_VERSION) {
    throw new Error(`不识别的账本版本：${String(root.version)}`)
  }

  if (!Array.isArray(root.markers)) {
    return { markers: [], issues: [{ kind: 'invalid-marker', index: -1, reason: 'markers 不是数组', raw: root.markers }] }
  }
  const markerList: unknown[] = root.markers

  /* 第一遍：形状校验与标识唯一性（隔离后不再参与配对判定） */
  const issues: TimelineLedgerIssue[] = []
  const candidates: { index: number; marker: TimelineMarker }[] = []
  const seenMarkerIds = new Set<string>()

  markerList.forEach((item, index) => {
    const marker = reviveTimelineMarker(item)
    if (!marker) {
      issues.push({ kind: 'invalid-marker', index, reason: describeTimelineMarker(item), raw: item })
      return
    }
    if (seenMarkerIds.has(marker.id)) {
      issues.push({
        kind: 'duplicate-marker-id',
        index,
        id: marker.id,
        reason: `时间标记标识 ${marker.id} 与前面的条目重复`,
        raw: item,
      })
      return
    }
    seenMarkerIds.add(marker.id)
    candidates.push({ index, marker })
  })

  /* 第二遍：事件标识唯一（point / start 各自携带详情，同一 eventId 只允许一处） */
  const usable: { index: number; marker: TimelineMarker }[] = []
  const seenEventDetailIds = new Set<string>()
  for (const candidate of candidates) {
    const { index, marker } = candidate
    if (marker.kind !== 'end' && seenEventDetailIds.has(marker.eventId)) {
      issues.push({
        kind: 'duplicate-event-id',
        index,
        eventId: marker.eventId,
        reason: `事件标识 ${marker.eventId} 被多个携带详情的标记复用（同一事件只能有一处 point 或 start）`,
        raw: markerList[index],
      })
      continue
    }
    if (marker.kind !== 'end') {
      seenEventDetailIds.add(marker.eventId)
    }
    usable.push(candidate)
  }

  const pairing = collectPairingIssues(usable, (index) => markerList[index])
  issues.push(...pairing.issues)
  issues.sort((left, right) => left.index - right.index)

  return { markers: pairing.markers, issues }
}

/**
 * 配对与顺序判定（第三遍校验，revive 与移动标记后的重校验共用）：
 * 孤立结束 / 无结束开始 / 倒置一律按 issue 报告，绝不自动修补。
 * 返回通过配对的标记列表（保持原顺序）与全部配对 issue。
 */
function collectPairingIssues(
  usable: { index: number; marker: TimelineMarker }[],
  rawOf: (index: number) => unknown,
): { markers: TimelineMarker[]; issues: TimelineLedgerIssue[] } {
  const issues: TimelineLedgerIssue[] = []
  const claimedStartIds = new Set<string>()
  const pairingIsolatedIndexes = new Set<number>()
  for (const { index, marker } of usable) {
    if (marker.kind !== 'end') {
      continue
    }
    const start = usable.find(
      (candidate) => candidate.marker.kind === 'start' && candidate.marker.id === marker.startId,
    )
    const fail = (issue: Extract<TimelineLedgerIssue, { index: number }>) => {
      issues.push(issue)
      pairingIsolatedIndexes.add(index)
    }
    if (!start) {
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `结束标记回指的开始标记 ${marker.startId} 不存在`, raw: rawOf(index) })
      continue
    }
    if (start.marker.eventId !== marker.eventId) {
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `结束标记的事件标识 ${marker.eventId} 与其回指开始标记的事件标识 ${start.marker.eventId} 不一致`, raw: rawOf(index) })
      continue
    }
    if (claimedStartIds.has(marker.startId)) {
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `开始标记 ${marker.startId} 已有其他结束标记配对（一一配对约束）`, raw: rawOf(index) })
      continue
    }
    if (index < start.index) {
      fail({ kind: 'reversed-span', index, id: marker.id, eventId: marker.eventId, reason: `结束标记出现在开始标记 ${marker.startId} 之前（区间倒置）`, raw: rawOf(index) })
      continue
    }
    claimedStartIds.add(marker.startId)
  }

  const markers = usable
    .filter(({ index, marker }) => {
      if (marker.kind === 'start' && !claimedStartIds.has(marker.id)) {
        issues.push({
          kind: 'unpaired-start',
          index,
          id: marker.id,
          eventId: marker.eventId,
          reason: `开始标记没有对应的结束标记（区间两端必须成对）`,
          raw: rawOf(index),
        })
        return false
      }
      return !pairingIsolatedIndexes.has(index)
    })
    .map(({ marker }) => marker)

  return { markers, issues }
}

/* ---------- 单条标记与事件详情的形状校验 ---------- */

function reviveTimelineMarker(raw: unknown): TimelineMarker | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const eventId = typeof record.eventId === 'string' ? record.eventId.trim() : ''

  if (!MARKER_ID_PATTERN.test(id) || !EVENT_ID_PATTERN.test(eventId)) {
    return null
  }

  if (record.kind === 'point' || record.kind === 'start') {
    const event = reviveTimelineEvent(record.event)
    if (!event) {
      return null
    }
    return { id, kind: record.kind, eventId, event }
  }

  if (record.kind === 'end') {
    const startId = typeof record.startId === 'string' ? record.startId.trim() : ''
    if (!MARKER_ID_PATTERN.test(startId)) {
      return null
    }
    return { id, kind: 'end', eventId, startId }
  }

  return null
}

function reviveTimelineEvent(raw: unknown): TimelineEvent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : ''
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
  if (!title || !createdAt || !updatedAt) {
    return null
  }

  const summary = typeof record.summary === 'string' ? record.summary : ''
  const storyTime = reviveStoryTime(record.storyTime)
  const relativeTime = reviveRelativeTime(record.relativeTime)
  const participants = reviveParticipants(record.participants)
  const plotIds = reviveIdList(record.plotIds)
  const chapters = reviveChapterRefs(record.chapters)
  const causedBy = reviveIdList(record.causedBy, EVENT_ID_PATTERN)

  if (!storyTime.valid || !relativeTime.valid || !participants.valid || !plotIds.valid || !chapters.valid || !causedBy.valid) {
    return null
  }

  return {
    title,
    summary,
    storyTime: storyTime.value,
    relativeTime: relativeTime.value,
    participants: participants.value,
    plotIds: plotIds.value,
    chapters: chapters.value,
    causedBy: causedBy.value,
    createdAt,
    updatedAt,
  }
}

/** 字段解析结果：valid=false 表示非法（隔离），与「缺省为 null/空数组」的合法形态区分开。 */
type FieldParse<T> = { valid: true; value: T } | { valid: false }

function reviveStoryTime(raw: unknown): FieldParse<TimelineEvent['storyTime']> {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null }
  }
  if (typeof raw !== 'object') {
    return { valid: false }
  }
  const record = raw as Record<string, unknown>
  if (typeof record.year !== 'number' || !Number.isFinite(record.year)) {
    return { valid: false }
  }
  if (record.calendar !== undefined && typeof record.calendar !== 'string') {
    return { valid: false }
  }
  if (record.season !== undefined && typeof record.season !== 'string') {
    return { valid: false }
  }
  if (!isOptionalIntegerInRange(record.month, 1, 12) || !isOptionalIntegerInRange(record.day, 1, 31)) {
    return { valid: false }
  }
  const calendar = typeof record.calendar === 'string' ? record.calendar.trim() : ''
  const season = typeof record.season === 'string' ? record.season.trim() : ''
  return {
    valid: true,
    value: {
      ...(calendar ? { calendar } : {}),
      year: record.year,
      ...(season ? { season } : {}),
      ...(record.month !== undefined ? { month: record.month as number } : {}),
      ...(record.day !== undefined ? { day: record.day as number } : {}),
    },
  }
}

function isOptionalIntegerInRange(raw: unknown, minimum: number, maximum: number): boolean {
  return raw === undefined
    || (typeof raw === 'number' && Number.isInteger(raw) && raw >= minimum && raw <= maximum)
}

function reviveRelativeTime(raw: unknown): FieldParse<TimelineEvent['relativeTime']> {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null }
  }
  if (typeof raw !== 'object') {
    return { valid: false }
  }
  const record = raw as Record<string, unknown>
  const anchorEventId = typeof record.anchorEventId === 'string' ? record.anchorEventId.trim() : ''
  const unit = typeof record.unit === 'string' ? record.unit.trim() : ''
  if (
    !EVENT_ID_PATTERN.test(anchorEventId)
    || typeof record.offset !== 'number'
    || !Number.isFinite(record.offset)
    || !unit
    || (record.direction !== 'before' && record.direction !== 'after')
  ) {
    return { valid: false }
  }
  return { valid: true, value: { anchorEventId, offset: record.offset, unit, direction: record.direction } }
}

function reviveParticipants(raw: unknown): FieldParse<TimelineEvent['participants']> {
  if (raw === undefined || raw === null) {
    return { valid: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { valid: false }
  }
  const participants: NonNullable<TimelineEvent['participants']> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { valid: false }
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (record.kind !== 'element' || !id) {
      return { valid: false }
    }
    if (record.role !== undefined && typeof record.role !== 'string') {
      return { valid: false }
    }
    participants.push({
      kind: 'element',
      id,
      ...(record.role !== undefined ? { role: record.role } : {}),
    })
  }
  return { valid: true, value: participants }
}

function reviveChapterRefs(raw: unknown): FieldParse<TimelineEvent['chapters']> {
  if (raw === undefined || raw === null) {
    return { valid: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { valid: false }
  }
  const chapters: NonNullable<TimelineEvent['chapters']> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { valid: false }
    }
    const record = item as Record<string, unknown>
    if (
      typeof record.chapterNumber !== 'number'
      || !Number.isInteger(record.chapterNumber)
      || record.chapterNumber < 1
      || (record.mode !== 'current' && record.mode !== 'recall' && record.mode !== 'prophecy' && record.mode !== 'dream')
    ) {
      return { valid: false }
    }
    chapters.push({ chapterNumber: record.chapterNumber, mode: record.mode })
  }
  return { valid: true, value: chapters }
}

function reviveIdList(raw: unknown, pattern?: RegExp): FieldParse<string[]> {
  if (raw === undefined || raw === null) {
    return { valid: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { valid: false }
  }
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { valid: false }
    }
    const id = item.trim()
    if (!id || (pattern && !pattern.test(id))) {
      return { valid: false }
    }
    ids.push(id)
  }
  return { valid: true, value: ids }
}

function describeTimelineMarker(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    return '条目不是对象'
  }
  const record = raw as Record<string, unknown>
  const missing: string[] = []
  if (typeof record.id !== 'string' || !MARKER_ID_PATTERN.test(record.id.trim())) missing.push('id（应为 TM- 前缀标识）')
  if (typeof record.eventId !== 'string' || !EVENT_ID_PATTERN.test(record.eventId.trim())) missing.push('eventId（应为 EVT- 前缀标识）')
  if (record.kind !== 'point' && record.kind !== 'start' && record.kind !== 'end') {
    missing.push('kind（point/start/end）')
  } else if (record.kind === 'end') {
    if (typeof record.startId !== 'string' || !MARKER_ID_PATTERN.test(record.startId.trim())) missing.push('startId')
  } else if (typeof record.event !== 'object' || record.event === null) {
    missing.push('event（事件详情）')
  }
  return missing.length > 0 ? `缺少或非法字段：${missing.join('、')}` : '字段格式不合法'
}

/* ---------- 序列化与写入 ---------- */

export function serializeTimelineLedger(document: TimelineLedgerDocument, options: { preserveIssues?: boolean } = {}): string {
  let markers: unknown[] = document.markers
  if (options.preserveIssues && document.issues.length > 0) {
    // 原样写回隔离条目（按原位置插回），只有用户明确「清理」时才丢弃
    markers = [...document.markers]
    const markerIssues = document.issues
      .filter((issue): issue is Extract<TimelineLedgerIssue, { index: number }> => issue.index >= 0)
      .sort((left, right) => left.index - right.index)
    for (const issue of markerIssues) {
      markers.splice(Math.min(issue.index, markers.length), 0, issue.raw)
    }
  }
  return JSON.stringify(
    {
      version: TIMELINE_LEDGER_VERSION,
      markers,
    },
    null,
    2,
  )
}

/** 结构性损坏（markers 整体不是数组）无法原样写回，任何写入都必须先清理。 */
export function hasStructuralIssue(document: TimelineLedgerDocument): boolean {
  return document.issues.some((issue) => issue.kind === 'invalid-marker' && issue.index < 0)
}

/** 结构写入存在非法条目时统一拒绝：不清理就把手工坏数据静默洗掉等于丢用户数据。 */
export function assertWritable(document: TimelineLedgerDocument): void {
  if (document.issues.length > 0) {
    throw new TimelineError(
      `时间线账本存在 ${document.issues.length} 条异常数据（格式非法、标识重复或配对破坏），写入已被阻止；`
      + '请先在时间轴弹窗中查看并清理异常条目，再继续登记或修改事件',
    )
  }
}

async function persistLedger(project: ProjectSnapshot, document: TimelineLedgerDocument, options: { preserveIssues?: boolean } = {}): Promise<string> {
  try {
    const { contentHash } = await writeJsonLedger({
      project,
      path: TIMELINE_LEDGER_PATH,
      ledger: null,
      expectedContentHash: document.contentHash,
      serialize: () => serializeTimelineLedger(document, options),
    })
    return contentHash
  } catch (error) {
    if (error instanceof JsonLedgerConflictError) {
      throw new TimelineConflictError(error.currentContentHash)
    }
    throw error
  }
}

/* ---------- 标识生成（域内唯一性由调用处结合账本现状保证） ---------- */

function generateDomainId(prefix: 'EVT' | 'TM'): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let out = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(10)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      out += alphabet[byte % alphabet.length]
    }
  } else {
    for (let index = 0; index < 10; index += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
  }
  return `${prefix}-${out}`
}

export function generateTimelineEventId(): string {
  return generateDomainId('EVT')
}

export function generateTimelineMarkerId(): string {
  return generateDomainId('TM')
}

/* ---------- 事件输入、定位与引用校验（阶段 2） ---------- */

/**
 * 要素引用选择器：稳定标识 /「类型 + 精确名称」/ 要素文件路径三选一（与关系节点同款语义）。
 * 路径定位给 UI 选择器用：尚无稳定标识的要素（标识首次被引用时才懒分配）按路径解析后再分配。
 */
export type TimelineElementSelector =
  | TimelineAgentElementSelector
  | { kind: 'element'; sourcePath: string }

/** 智能体工具可用的子集：标识或「类型 + 名称」（工具入参不暴露路径定位）。 */
export type TimelineAgentElementSelector =
  | { kind: 'element'; id: string }
  | { kind: 'element'; type: ElementType; name: string }

export type TimelineParticipantInput = TimelineElementSelector & { role?: string }

/** 事件详情写入输入（create / update 共用；undefined = 不改动，update 语义）。 */
export type TimelineEventInput = {
  title?: string
  summary?: string
  storyTime?: StoryTime | null
  relativeTime?: RelativeTime | null
  participants?: TimelineParticipantInput[]
  plots?: TimelineElementSelector[]
  chapters?: TimelineChapterRef[]
  causedBy?: string[]
}

/** 单事件版本令牌（内容决定，跨读取稳定；UI 编辑会话按条做冲突判定）。 */
export function timelineEventVersion(event: TimelineEvent): string {
  return hashContent(JSON.stringify([event.title, event.summary, event.storyTime, event.relativeTime, event.participants, event.plotIds, event.chapters, event.causedBy, event.updatedAt]))
}

/** 结构写入前刷新文件树并重建引用索引（新要素落盘后立即可被引用）。 */
async function freshReferenceIndex(project: ProjectSnapshot): Promise<{ snapshot: ProjectSnapshot; index: ElementReferenceIndex }> {
  const tree = await rescanProject(project)
  const snapshot = { ...project, tree }
  return { snapshot, index: await buildElementReferenceIndex(snapshot) }
}

/** 只读解析要素引用（不写盘）：存在性、唯一性、类型限定；旧时间线要素拒绝。 */
function locateTimelineElement(
  index: ElementReferenceIndex,
  selector: TimelineElementSelector,
  allowedTypes: readonly ElementType[],
  label: string,
): ElementReferenceEntry {
  let entry: ElementReferenceEntry

  if ('id' in selector) {
    const resolution = resolveElementById(index, selector.id)
    if (resolution.status === 'missing') {
      throw new TimelineError(
        `${label} 引用的要素 ${selector.id} 找不到；要素可能已删除或标识有误，请改用「类型 + 名称」定位或先创建该要素`,
      )
    }
    if (resolution.status === 'ambiguous') {
      throw new TimelineError(
        `${label} 引用的标识 ${selector.id} 被多个要素占用（${resolution.sourcePaths.join('、')}），无法确定指向；请先在要素库中修正重复标识`,
      )
    }
    entry = resolution.entry
  } else if ('sourcePath' in selector) {
    const hit = index.entries.find((candidate) => candidate.sourcePath === selector.sourcePath)
    if (!hit) {
      throw new TimelineError(`${label} 引用的要素文件 ${selector.sourcePath} 找不到；可能已被删除或改名，请重新选择`)
    }
    entry = hit
  } else {
    const exact = searchElementEntries(index, selector.name, selector.type).filter((candidate) => candidate.name === selector.name)
    if (exact.length === 0) {
      throw new TimelineError(
        `${label} 在 ${selector.type} 中找不到名为「${selector.name}」的要素；请核对要素名（区分大小写与全半角），或先创建该要素文件`,
      )
    }
    if (exact.length > 1) {
      throw new TimelineError(
        `${label}：${selector.type} 中有 ${exact.length} 个名为「${selector.name}」的要素，无法确定指向；请先消除重名`,
      )
    }
    entry = exact[0]!
  }

  if (!allowedTypes.includes(entry.type)) {
    throw new TimelineError(
      `${label} 引用的「${entry.name}」类型是 ${entry.type}，不在允许范围（${allowedTypes.join(' / ')}）`,
    )
  }
  return entry
}

/** 章节引用校验：章号必须能在章节目录中解析（重号允许多候选，视图侧呈现待消歧）。 */
function assertChapterRefsResolvable(project: ProjectSnapshot, chapters: readonly TimelineChapterRef[]): void {
  if (chapters.length === 0) {
    return
  }
  const catalog = buildChapterCatalog(project.tree)
  for (const ref of chapters) {
    if (!catalog.entries.some((entry) => entry.number === ref.chapterNumber)) {
      const hint = catalog.maxNumber === null
        ? '项目里还没有任何章节'
        : `当前最大章号是第${catalog.maxNumber}章`
      throw new TimelineError(
        `章节引用「第${ref.chapterNumber}章」无法解析：${hint}；请先创建该章节或核对章号（章节按全本章号位置关联）`,
      )
    }
  }
}

/**
 * 组装事件详情：先做完全部只读校验（要素引用 / 章节解析 / 事件互引），再懒分配标识
 * （assignElementIds）——失败的调用不得改写任何要素文件（与关系域同一铁律）。
 *
 * `baseEvent`（update 语境传入修改前的事件）：与基线相同的引用不重新解析——悬空参与者、
 * 失效相对锚、章号已删的章节引用不阻塞其他字段编辑，留给检查层提示（对齐关系域
 * review 修复批「与当前引用相同的标识不再重新解析」的口径）。
 */
async function assembleTimelineEvent(
  project: ProjectSnapshot,
  existingEventIds: ReadonlySet<string>,
  input: TimelineEventInput,
  label: string,
  options: { validateRelativeAnchor?: boolean; baseEvent?: TimelineEvent } = {},
): Promise<{ event: TimelineEvent; assignedElementIds: { sourcePath: string; id: string }[] }> {
  const validateRelativeAnchor = options.validateRelativeAnchor ?? true
  const base = options.baseEvent
  const baseParticipantIds = new Set(base?.participants.map((participant) => participant.id) ?? [])
  const basePlotIds = new Set(base?.plotIds ?? [])
  const baseChapterNumbers = new Set(base?.chapters.map((ref) => ref.chapterNumber) ?? [])
  const baseCausedBy = new Set(base?.causedBy ?? [])
  const baseRelativeTime = base?.relativeTime ?? null
  const title = (input.title ?? '').trim()
  if (!title) {
    throw new TimelineError(`${label}.title 不能为空；用一句话概括这个事件（如「小张出生」「旧桥决裂」）`)
  }
  if (input.storyTime !== undefined && input.storyTime !== null && (typeof input.storyTime.year !== 'number' || !Number.isFinite(input.storyTime.year))) {
    throw new TimelineError(`${label}.storyTime.year 必须是数值（架空纪年可为负）；系统不理解历法语义，只做记录`)
  }
  // 写入侧与载入校验（reviveStoryTime）同一口径：否则越界月/日能写进去，下次载入却被隔离为非法条目、阻塞整本写入
  if (input.storyTime && !isOptionalIntegerInRange(input.storyTime.month, 1, 12)) {
    throw new TimelineError(`${label}.storyTime.month 必须是 1–12 的整数（不填则省略）`)
  }
  if (input.storyTime && !isOptionalIntegerInRange(input.storyTime.day, 1, 31)) {
    throw new TimelineError(`${label}.storyTime.day 必须是 1–31 的整数（不填则省略）`)
  }

  // 事件互引（因果前驱 / 相对时间锚）：只校验本次显式给出的引用；与基线相同的引用跳过存在性核对
  const causedBy = (input.causedBy ?? []).map((id) => id.trim())
  for (const id of causedBy) {
    if (!EVENT_ID_PATTERN.test(id)) {
      throw new TimelineError(`${label}.causedBy 的 ${id} 不是合法事件标识（EVT- 前缀）`)
    }
    if (!baseCausedBy.has(id) && !existingEventIds.has(id)) {
      throw new TimelineError(`${label}.causedBy 引用的事件 ${id} 不存在；请先用 TimelineList/Read 核对事件标识`)
    }
  }
  if (validateRelativeAnchor && input.relativeTime !== undefined && input.relativeTime !== null) {
    const relative = input.relativeTime
    if (!EVENT_ID_PATTERN.test(relative.anchorEventId)) {
      throw new TimelineError(`${label}.relativeTime.anchorEventId 必须是 EVT- 事件标识`)
    }
    // 与基线完全相同的相对时间（含已失效锚）不重新核对存在性，原样保留
    const sameAsBase = JSON.stringify(relative) === JSON.stringify(baseRelativeTime)
    if (!sameAsBase && !existingEventIds.has(relative.anchorEventId)) {
      throw new TimelineError(
        `${label}.relativeTime 的锚事件 ${relative.anchorEventId} 不存在；相对时间必须锚定既有事件（如「决战后的第三天」锚定决战事件）`,
      )
    }
    if (typeof relative.offset !== 'number' || !Number.isFinite(relative.offset)) {
      throw new TimelineError(`${label}.relativeTime.offset 必须是数值`)
    }
    if (!String(relative.unit).trim()) {
      throw new TimelineError(`${label}.relativeTime.unit 不能为空（如 day / month / year / era）`)
    }
    if (relative.direction !== 'before' && relative.direction !== 'after') {
      throw new TimelineError(`${label}.relativeTime.direction 必须是 before 或 after`)
    }
  }

  const chapters = input.chapters ?? []
  for (const ref of chapters) {
    if (!Number.isInteger(ref.chapterNumber) || ref.chapterNumber < 1) {
      throw new TimelineError(`${label}.chapters 的章号必须是正整数`)
    }
    if (ref.mode !== 'current' && ref.mode !== 'recall' && ref.mode !== 'prophecy' && ref.mode !== 'dream') {
      throw new TimelineError(`${label}.chapters.mode 必须是 current / recall / prophecy / dream 之一（正文当下 / 回忆 / 预言 / 梦境）`)
    }
  }

  // 只读解析要素引用（参与者四类 + 情节），校验全部通过后才懒分配；与基线相同的按标识引用原样透传
  const { snapshot, index } = await freshReferenceIndex(project)
  const participantEntries: Array<{ entry: ElementReferenceEntry | null; passthrough?: TimelineParticipant; role?: string }> = []
  for (const participant of input.participants ?? []) {
    if ('id' in participant && baseParticipantIds.has(participant.id)) {
      participantEntries.push({ entry: null, passthrough: participant, ...(participant.role !== undefined ? { role: participant.role } : {}) })
      continue
    }
    participantEntries.push({
      entry: locateTimelineElement(index, participant, TIMELINE_PARTICIPANT_TYPES, `${label}.participants`),
      ...(participant.role !== undefined ? { role: participant.role } : {}),
    })
  }
  const plotEntries: Array<{ entry: ElementReferenceEntry | null; passthroughId?: string }> = []
  for (const plot of input.plots ?? []) {
    if ('id' in plot && basePlotIds.has(plot.id)) {
      plotEntries.push({ entry: null, passthroughId: plot.id })
      continue
    }
    plotEntries.push({ entry: locateTimelineElement(index, plot, ['plot'], `${label}.plots`) })
  }
  const chaptersToResolve = chapters.filter((ref) => !baseChapterNumbers.has(ref.chapterNumber))
  assertChapterRefsResolvable(snapshot, chaptersToResolve)

  const assignedElementIds: { sourcePath: string; id: string }[] = []
  const resolveId = async (entry: ElementReferenceEntry): Promise<string> => {
    const ensured = await ensureElementId(snapshot, entry.sourcePath)
    if (ensured.assigned) {
      assignedElementIds.push({ sourcePath: entry.sourcePath, id: ensured.id })
    }
    return ensured.id
  }
  const participants: TimelineParticipant[] = []
  for (const { entry, passthrough, role } of participantEntries) {
    if (!entry) {
      // 基线透传：引用未变，即使已悬空也原样保留（检查层负责提示）
      participants.push({ ...(passthrough ?? { kind: 'element', id: '' }) })
      continue
    }
    const id = await resolveId(entry)
    participants.push({ kind: 'element', id, ...(role !== undefined ? { role: role } : {}) })
  }
  const plotIds: string[] = []
  for (const { entry, passthroughId } of plotEntries) {
    if (!entry) {
      plotIds.push(passthroughId ?? '')
      continue
    }
    plotIds.push(await resolveId(entry))
  }

  const now = new Date().toISOString()
  return {
    event: {
      title,
      summary: input.summary ?? '',
      storyTime: input.storyTime ?? null,
      relativeTime: input.relativeTime ?? null,
      participants,
      plotIds,
      chapters,
      causedBy,
      createdAt: now,
      updatedAt: now,
    },
    assignedElementIds,
  }
}

/** 解析插入定位为候选列表下标（first=0 / last=len / before|after 锚标记）。 */
function resolveInsertIndex(markers: readonly TimelineMarker[], position: TimelineInsertPosition, label: string): number {
  if (position.at === 'first') {
    return 0
  }
  if (position.at === 'last') {
    return markers.length
  }
  const anchorIndex = markers.findIndex((marker) => marker.id === position.anchorMarkerId)
  if (anchorIndex === -1) {
    throw new TimelineError(
      `${label} 的锚标记 ${position.anchorMarkerId} 不存在；插入前建议先用 TimelineRead 读锚点附近的局部时间线，拿最新的标记标识`,
    )
  }
  return position.at === 'before' ? anchorIndex : anchorIndex + 1
}

/* ---------- 增删改（全部走写锁） ---------- */

export type CreateTimelinePointOptions = {
  event: TimelineEventInput
  position: TimelineInsertPosition
  now?: Date
}

export type CreateTimelineResult = {
  marker: TimelineMarker
  /** 区间事件才有：结束标记 */
  endMarker?: TimelineMarker
  contentHash: string
  assignedElementIds: { sourcePath: string; id: string }[]
  /** 账本文件是否为本次新建（变更账本 created/updated 区分用） */
  created: boolean
}

/** 当前账本中「携带详情的事件标识」集合（causedBy / 相对时间锚的合法域）。 */
function collectExistingEventIds(markers: readonly TimelineMarker[]): Set<string> {
  const ids = new Set<string>()
  for (const marker of markers) {
    if (marker.kind !== 'end') {
      ids.add(marker.eventId)
    }
  }
  return ids
}

export async function createTimelinePoint(project: ProjectSnapshot, options: CreateTimelinePointOptions): Promise<CreateTimelineResult> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    assertWritable(document)

    const insertIndex = resolveInsertIndex(document.markers, options.position, 'TimelineCreatePoint.position')
    const { event, assignedElementIds } = await assembleTimelineEvent(
      project,
      collectExistingEventIds(document.markers),
      options.event,
      'TimelineCreatePoint',
    )

    const marker: TimelineMarker = {
      id: generateTimelineMarkerId(),
      kind: 'point',
      eventId: generateTimelineEventId(),
      event: options.now ? { ...event, createdAt: options.now.toISOString(), updatedAt: options.now.toISOString() } : event,
    }
    document.markers = [...document.markers.slice(0, insertIndex), marker, ...document.markers.slice(insertIndex)]
    const contentHash = await persistLedger(project, document)

    return { marker, contentHash, assignedElementIds, created: document.contentHash === null }
  })
}

export type CreateTimelineSpanOptions = {
  event: TimelineEventInput
  startPosition: TimelineInsertPosition
  endPosition: TimelineInsertPosition
  now?: Date
}

export async function createTimelineSpan(project: ProjectSnapshot, options: CreateTimelineSpanOptions): Promise<CreateTimelineResult> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    assertWritable(document)

    const startIndex = resolveInsertIndex(document.markers, options.startPosition, 'TimelineCreateSpan.startPosition')
    const endIndex = resolveInsertIndex(document.markers, options.endPosition, 'TimelineCreateSpan.endPosition')
    if (endIndex < startIndex) {
      throw new TimelineError(
        `区间事件的结束标记必须位于开始标记之后（当前开始落在第 ${startIndex + 1} 位、结束落在第 ${endIndex + 1} 位）；`
        + '结束位置请锚定在开始位置之后的标记（区间可跨越任意多的事件，表达并行与嵌套）',
      )
    }

    const { event, assignedElementIds } = await assembleTimelineEvent(
      project,
      collectExistingEventIds(document.markers),
      options.event,
      'TimelineCreateSpan',
    )
    const timestamp = options.now?.toISOString()
    const detail = timestamp ? { ...event, createdAt: timestamp, updatedAt: timestamp } : event
    const eventId = generateTimelineEventId()
    const startMarker: TimelineMarker = {
      id: generateTimelineMarkerId(),
      kind: 'start',
      eventId,
      event: detail,
    }
    const endMarker: TimelineMarker = {
      id: generateTimelineMarkerId(),
      kind: 'end',
      eventId,
      startId: startMarker.id,
    }

    // 先插开始（下标及之后整体右移一位），结束的落点相应右移；两端相邻（endIndex === startIndex）合法
    const shiftedEndIndex = endIndex >= startIndex ? endIndex + 1 : endIndex
    const markers = [...document.markers.slice(0, startIndex), startMarker, ...document.markers.slice(startIndex)]
    document.markers = [...markers.slice(0, shiftedEndIndex), endMarker, ...markers.slice(shiftedEndIndex)]
    const contentHash = await persistLedger(project, document)

    return { marker: startMarker, endMarker, contentHash, assignedElementIds, created: document.contentHash === null }
  })
}

export type UpdateTimelineEventOptions = {
  eventId: string
  /** 至少提供一项要修改的字段 */
  patch: TimelineEventInput
  /** 调用方持有的整本账本基线内容哈希；与磁盘不一致即冲突 */
  expectedContentHash?: string
  /** 调用方持有的这一事件版本令牌；只有该事件本身被改过才算冲突（UI 编辑会话用） */
  expectedEventVersion?: string
  now?: Date
}

export type UpdateTimelineEventResult = {
  marker: TimelineMarker
  previous: TimelineEvent
  contentHash: string
  assignedElementIds: { sourcePath: string; id: string }[]
}

export async function updateTimelineEvent(project: ProjectSnapshot, options: UpdateTimelineEventOptions): Promise<UpdateTimelineEventResult> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    assertWritable(document)

    if (options.expectedContentHash !== undefined && document.contentHash !== options.expectedContentHash) {
      throw new TimelineConflictError(document.contentHash)
    }

    const markerIndex = document.markers.findIndex(
      (marker) => marker.kind !== 'end' && marker.eventId === options.eventId,
    )
    if (markerIndex === -1) {
      if (options.expectedEventVersion !== undefined) {
        // 编辑会话的这条事件已被删除：按冲突处理（界面走「磁盘版本已不存在」出口）
        throw new TimelineConflictError(document.contentHash)
      }
      throw new TimelineError(`事件 ${options.eventId} 不存在；可能已被删除，请用 TimelineList 重新查看`)
    }
    const current = document.markers[markerIndex]!
    if (current.kind === 'end') {
      throw new TimelineError(`事件 ${options.eventId} 的载体异常（结束标记不携带详情），请联系开发者`)
    }
    if (options.expectedEventVersion !== undefined && timelineEventVersion(current.event) !== options.expectedEventVersion) {
      throw new TimelineConflictError(document.contentHash)
    }

    const patch = options.patch
    if (
      patch.title === undefined
      && patch.summary === undefined
      && patch.storyTime === undefined
      && patch.relativeTime === undefined
      && patch.participants === undefined
      && patch.plots === undefined
      && patch.chapters === undefined
      && patch.causedBy === undefined
    ) {
      throw new TimelineError('TimelineUpdate 至少提供一项要修改的字段（title/summary/storyTime/relativeTime/participants/plots/chapters/causedBy）')
    }

    const existingIds = collectExistingEventIds(document.markers)
    const merged = mergeEventPatch(current.event, patch)
    const { event, assignedElementIds } = await assembleTimelineEvent(
      project,
      existingIds,
      { ...merged, title: merged.title },
      'TimelineUpdate',
      // 锚事件已删除的旧 relativeTime 不阻塞其他字段编辑（失效提示交给检查层，不自动清除）
      { validateRelativeAnchor: patch.relativeTime !== undefined, baseEvent: current.event },
    )

    const previous = current.event
    const next: TimelineMarker = {
      ...current,
      event: { ...event, createdAt: previous.createdAt, updatedAt: (options.now ?? new Date()).toISOString() },
    }
    document.markers = document.markers.map((marker, index) => (index === markerIndex ? next : marker))
    const contentHash = await persistLedger(project, document)
    return { marker: next, previous, contentHash, assignedElementIds }
  })
}

/** update 的字段合并：undefined = 保留现值（相对时间锚已失效的旧值不动，不被隐式重校验卡死）。 */
function mergeEventPatch(current: TimelineEvent, patch: TimelineEventInput): TimelineEventInput {
  return {
    title: patch.title ?? current.title,
    summary: patch.summary ?? current.summary,
    storyTime: patch.storyTime !== undefined ? patch.storyTime : current.storyTime,
    relativeTime: patch.relativeTime !== undefined ? patch.relativeTime : current.relativeTime,
    // 参与者/情节持有的是已解析的 ELM 标识，直接透传（update 不换绑引用时不再重解析）
    participants: patch.participants ?? current.participants.map((participant) => ({ ...participant })),
    plots: patch.plots ?? current.plotIds.map((id) => ({ kind: 'element' as const, id })),
    chapters: patch.chapters ?? current.chapters,
    causedBy: patch.causedBy ?? current.causedBy,
  }
}

export type MoveTimelineMarkerOptions = {
  markerId: string
  position: TimelineInsertPosition
  now?: Date
}

export type MoveTimelineMarkerResult = {
  markers: TimelineMarker[]
  contentHash: string
}

export async function moveTimelineMarker(project: ProjectSnapshot, options: MoveTimelineMarkerOptions): Promise<MoveTimelineMarkerResult> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    assertWritable(document)

    const fromIndex = document.markers.findIndex((marker) => marker.id === options.markerId)
    if (fromIndex === -1) {
      throw new TimelineError(`时间标记 ${options.markerId} 不存在；可能已被删除，请重新读取时间线`)
    }
    if ((options.position.at === 'before' || options.position.at === 'after') && options.position.anchorMarkerId === options.markerId) {
      throw new TimelineError('移动标记不能以它自己为锚点；请锚定其他标记或用 first / last')
    }

    const without = document.markers.filter((_, index) => index !== fromIndex)
    const insertIndex = resolveInsertIndex(without, options.position, 'TimelineUpdate.position')
    const candidate = [...without.slice(0, insertIndex), document.markers[fromIndex]!, ...without.slice(insertIndex)]

    // 移动后重校验配对与顺序（锚点不得落在本区间内部 / 开始必须先于结束）
    const pairing = collectPairingIssues(candidate.map((marker, index) => ({ index, marker })), () => null)
    if (pairing.issues.length > 0) {
      const reason = pairing.issues.map((issue) => issue.reason).join('；')
      throw new TimelineError(
        `移动 ${options.markerId} 会破坏区间配对：${reason}。区间开始必须先于结束，且不能把任一端移进自己区间的内部`,
      )
    }

    document.markers = candidate
    const contentHash = await persistLedger(project, document)
    return { markers: document.markers, contentHash }
  })
}

export type DeleteTimelineEventOptions = {
  eventId: string
}

export type DeleteTimelineEventResult = {
  removed: TimelineMarker[]
  /** 其他事件 causedBy 中指向该事件的引用清除计数（relativeTime 锚不自动清除，进失效提示） */
  cascadedCausedBy: number
  contentHash: string
}

export async function deleteTimelineEvent(project: ProjectSnapshot, options: DeleteTimelineEventOptions): Promise<DeleteTimelineEventResult> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    assertWritable(document)

    const removed = document.markers.filter((marker) => marker.eventId === options.eventId)
    if (removed.length === 0) {
      throw new TimelineError(`事件 ${options.eventId} 不存在；可能已被删除`)
    }
    if (removed.some((marker) => marker.kind === 'end') && removed.length === 1) {
      // 只有孤立 end 指向该事件：end 不携带详情，不可能单独成为删除目标
      throw new TimelineError(`事件 ${options.eventId} 在账本中只剩结束标记（数据异常），请先在时间轴中清理异常条目`)
    }

    document.markers = document.markers.filter((marker) => marker.eventId !== options.eventId)

    // 级联：清除其他事件 causedBy 中指向该事件的引用；relativeTime 锚保留并进失效提示
    let cascadedCausedBy = 0
    document.markers = document.markers.map((marker) => {
      if (marker.kind === 'end') {
        return marker
      }
      const causedBy = marker.event.causedBy.filter((id) => {
        if (id === options.eventId) {
          cascadedCausedBy += 1
          return false
        }
        return true
      })
      return causedBy === marker.event.causedBy ? marker : { ...marker, event: { ...marker.event, causedBy } }
    })

    const contentHash = await persistLedger(project, document)
    return { removed, cascadedCausedBy, contentHash }
  })
}

/* ---------- 异常清理与要素级联 ---------- */

/** 清理账本中的隔离条目（用户在时间轴中明确确认后调用）。 */
export async function removeInvalidTimelineEntries(project: ProjectSnapshot): Promise<{ removed: TimelineLedgerIssue[]; contentHash: string }> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    if (document.issues.length === 0) {
      return { removed: [], contentHash: document.contentHash ?? '' }
    }
    const removed = document.issues
    document.issues = []
    const contentHash = await persistLedger(project, document)
    return { removed, contentHash }
  })
}

/**
 * 级联：删除要素时清理事件里对它的引用（参与者条目 / plotIds 项）。
 * 事件失去全部参与者仍然合法，不删除事件本身；隔离条目原样写回（级联不受隔离阻挡，
 * 但结构性损坏时让位于 assertWritable——那种状态下手工清理更安全）。
 */
async function removeElementReferences(
  project: ProjectSnapshot,
  elementIds: ReadonlySet<string>,
): Promise<{ removedParticipants: number; removedPlotLinks: number; contentHash: string | null }> {
  return withTimelineWriteLock(project, async () => {
    const document = await loadTimelineLedger(project)
    if (hasStructuralIssue(document)) {
      assertWritable(document)
    }

    let removedParticipants = 0
    let removedPlotLinks = 0
    let changed = false
    document.markers = document.markers.map((marker) => {
      if (marker.kind === 'end') {
        return marker
      }
      const participants = marker.event.participants.filter((participant) => {
        if (elementIds.has(participant.id)) {
          removedParticipants += 1
          return false
        }
        return true
      })
      const plotIds = marker.event.plotIds.filter((id) => {
        if (elementIds.has(id)) {
          removedPlotLinks += 1
          return false
        }
        return true
      })
      if (participants === marker.event.participants && plotIds === marker.event.plotIds) {
        return marker
      }
      changed = true
      return { ...marker, event: { ...marker.event, participants, plotIds, updatedAt: new Date().toISOString() } }
    })

    if (!changed) {
      return { removedParticipants: 0, removedPlotLinks: 0, contentHash: document.contentHash }
    }
    const contentHash = await persistLedger(project, document, { preserveIssues: true })
    return { removedParticipants, removedPlotLinks, contentHash }
  })
}

/** 级联（按标识）：DeleteFile 等握有 ELM 标识的链路调用。 */
export async function removeTimelineReferences(project: ProjectSnapshot, elementId: string): Promise<{ removedParticipants: number; removedPlotLinks: number }> {
  const result = await removeElementReferences(project, new Set([elementId]))
  return { removedParticipants: result.removedParticipants, removedPlotLinks: result.removedPlotLinks }
}

/** 级联（按路径）：先经引用索引把路径映射为标识，再统一清理。 */
export async function removeTimelineReferencesByPath(project: ProjectSnapshot, sourcePath: string): Promise<{ removedParticipants: number; removedPlotLinks: number; elementIds: string[] }> {
  const { index } = await freshReferenceIndex(project)
  const ids = index.entries.filter((entry) => entry.sourcePath === sourcePath && entry.id).map((entry) => entry.id)
  if (ids.length === 0) {
    return { removedParticipants: 0, removedPlotLinks: 0, elementIds: [] }
  }
  const result = await removeElementReferences(project, new Set(ids))
  return { removedParticipants: result.removedParticipants, removedPlotLinks: result.removedPlotLinks, elementIds: ids }
}

/* ---------- 查询与检查（只读，无锁） ---------- */

export type TimelineQueryFilter = {
  participantElementId?: string
  participantElementIds?: string[]
  plotId?: string
  chapterNumber?: number
  /** 明确时间可比较时按年份过滤（含两端；系统不跨历法换算） */
  yearFrom?: number
  yearTo?: number
}

export async function queryTimelineEvents(project: ProjectSnapshot, filter: TimelineQueryFilter): Promise<TimelineLedgerDocument> {
  const document = await loadTimelineLedger(project)
  document.markers = document.markers.filter((marker) => {
    if (marker.kind === 'end') {
      // 区间事件的详情在开始标记上；过滤时保留与开始同事件的结束标记，视图才能画出区间
      return true
    }
    const event = marker.event
    if (filter.participantElementId !== undefined) {
      if (!event.participants.some((participant) => participant.id === filter.participantElementId)) {
        return false
      }
    }
    if (filter.participantElementIds !== undefined) {
      const idSet = new Set(filter.participantElementIds)
      if (!event.participants.some((participant) => idSet.has(participant.id))) {
        return false
      }
    }
    if (filter.plotId !== undefined && !event.plotIds.includes(filter.plotId)) {
      return false
    }
    if (filter.chapterNumber !== undefined && !event.chapters.some((ref) => ref.chapterNumber === filter.chapterNumber)) {
      return false
    }
    const year = event.storyTime?.year
    if (filter.yearFrom !== undefined && (year === null || year === undefined || year < filter.yearFrom)) {
      return false
    }
    if (filter.yearTo !== undefined && (year === null || year === undefined || year > filter.yearTo)) {
      return false
    }
    return true
  })
  // 过滤掉的 point/start 若是区间开始，其结束标记也应移除（悬空的 end 不参与结果）
  const retainedEventIds = new Set(document.markers.map((marker) => marker.eventId))
  document.markers = document.markers.filter((marker) => {
    if (marker.kind !== 'end') {
      return true
    }
    return retainedEventIds.has(marker.eventId) && document.markers.some((candidate) => candidate.kind === 'start' && candidate.eventId === marker.eventId)
  })
  return document
}

export type TimelineContextResult = {
  /** 锚标记本身 */
  anchor: TimelineMarker
  /** 之前（或之后）N 条标记（含锚点，按列表顺序） */
  markers: TimelineMarker[]
}

/** 指定标记之前 / 之后 N 条的局部时间线（含锚点自身；插入前读局部上下文用）。 */
export function timelineMarkerContext(document: TimelineLedgerDocument, anchorMarkerId: string, direction: 'before' | 'after', count: number): TimelineContextResult {
  const anchorIndex = document.markers.findIndex((marker) => marker.id === anchorMarkerId)
  if (anchorIndex === -1) {
    throw new TimelineError(`时间标记 ${anchorMarkerId} 不存在；请重新读取时间线`)
  }
  const bounded = Math.max(1, Math.min(count, 30))
  const from = direction === 'before' ? Math.max(0, anchorIndex - bounded + 1) : anchorIndex
  const to = direction === 'before' ? anchorIndex + 1 : Math.min(document.markers.length, anchorIndex + bounded)
  return { anchor: document.markers[anchorIndex]!, markers: document.markers.slice(from, to) }
}

export type TimelineCheckIssue =
  | TimelineLedgerIssue
  | { kind: 'dangling-participant'; eventId: string; id: string }
  | { kind: 'ambiguous-participant'; eventId: string; id: string; sourcePaths: string[] }
  | { kind: 'dangling-plot'; eventId: string; id: string }
  | { kind: 'ambiguous-plot'; eventId: string; id: string; sourcePaths: string[] }
  | { kind: 'missing-chapter'; eventId: string; chapterNumber: number }
  | { kind: 'ambiguous-chapter'; eventId: string; chapterNumber: number }
  | { kind: 'dangling-caused-by'; eventId: string; targetEventId: string }
  | { kind: 'dangling-relative-anchor'; eventId: string; anchorEventId: string }

/** 全量检查：账本隔离条目 + 悬空/歧义引用 + 章节可解析性 + 事件互引。 */
export async function checkTimelineLedger(project: ProjectSnapshot): Promise<{ issues: TimelineCheckIssue[] }> {
  const { snapshot, index } = await freshReferenceIndex(project)
  const document = await loadTimelineLedger(project)
  const issues: TimelineCheckIssue[] = [...document.issues]
  const catalog = buildChapterCatalog(snapshot.tree)
  const eventIds = collectExistingEventIds(document.markers)

  for (const marker of document.markers) {
    if (marker.kind === 'end') {
      continue
    }
    const event = marker.event
    for (const participant of event.participants) {
      const resolution = resolveElementById(index, participant.id)
      if (resolution.status === 'missing') {
        issues.push({ kind: 'dangling-participant', eventId: marker.eventId, id: participant.id })
      } else if (resolution.status === 'ambiguous') {
        issues.push({ kind: 'ambiguous-participant', eventId: marker.eventId, id: participant.id, sourcePaths: resolution.sourcePaths })
      }
    }
    for (const plotId of event.plotIds) {
      const resolution = resolveElementById(index, plotId)
      if (resolution.status === 'missing') {
        issues.push({ kind: 'dangling-plot', eventId: marker.eventId, id: plotId })
      } else if (resolution.status === 'ambiguous') {
        issues.push({ kind: 'ambiguous-plot', eventId: marker.eventId, id: plotId, sourcePaths: resolution.sourcePaths })
      }
    }
    for (const ref of event.chapters) {
      const matches = catalog.entries.filter((entry) => entry.number === ref.chapterNumber)
      if (matches.length === 0) {
        issues.push({ kind: 'missing-chapter', eventId: marker.eventId, chapterNumber: ref.chapterNumber })
      } else if (matches.length > 1) {
        issues.push({ kind: 'ambiguous-chapter', eventId: marker.eventId, chapterNumber: ref.chapterNumber })
      }
    }
    for (const target of event.causedBy) {
      if (!eventIds.has(target)) {
        issues.push({ kind: 'dangling-caused-by', eventId: marker.eventId, targetEventId: target })
      }
    }
    if (event.relativeTime && !eventIds.has(event.relativeTime.anchorEventId)) {
      // 锚事件已删除：字段进入失效提示（不自动清除），作者决定改锚或删字段
      issues.push({ kind: 'dangling-relative-anchor', eventId: marker.eventId, anchorEventId: event.relativeTime.anchorEventId })
    }
  }

  return { issues }
}
