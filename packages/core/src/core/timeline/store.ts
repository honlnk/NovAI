import {
  JsonLedgerConflictError,
  JsonLedgerCorruptError,
  readJsonLedger,
  writeJsonLedger,
} from '../ledger/json-ledger'

import type { ProjectSnapshot } from '../../types/project'
import type {
  TimelineEvent,
  TimelineLedgerDocument,
  TimelineLedgerIssue,
  TimelineMarker,
} from '../../types/timeline'
import {
  EVENT_ID_PATTERN,
  MARKER_ID_PATTERN,
  TIMELINE_LEDGER_PATH,
  TIMELINE_LEDGER_VERSION,
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

  /* 第三遍：区间配对与顺序（孤立结束 / 无结束开始 / 倒置一律隔离，不自动修补） */
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
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `结束标记回指的开始标记 ${marker.startId} 不存在`, raw: markerList[index] })
      continue
    }
    if (start.marker.eventId !== marker.eventId) {
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `结束标记的事件标识 ${marker.eventId} 与其回指开始标记的事件标识 ${start.marker.eventId} 不一致`, raw: markerList[index] })
      continue
    }
    if (claimedStartIds.has(marker.startId)) {
      fail({ kind: 'orphan-end', index, id: marker.id, startId: marker.startId, reason: `开始标记 ${marker.startId} 已有其他结束标记配对（一一配对约束）`, raw: markerList[index] })
      continue
    }
    if (index < start.index) {
      fail({ kind: 'reversed-span', index, id: marker.id, eventId: marker.eventId, reason: `结束标记出现在开始标记 ${marker.startId} 之前（区间倒置）`, raw: markerList[index] })
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
          raw: markerList[index],
        })
        return false
      }
      return !pairingIsolatedIndexes.has(index)
    })
    .map(({ marker }) => marker)

  issues.sort((left, right) => left.index - right.index)

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
