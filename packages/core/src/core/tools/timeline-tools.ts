import { countDiffLines } from './file-tools/diff-line-stats'
import { asRecord, readString } from './file-tools/common'
import {
  timelineMarkerContext,
  TimelineCorruptError,
  timelineEventVersion,
  type TimelineElementSelector,
} from '../timeline/store'
import type { TimelineParticipantInput } from '../timeline/store'
import type {
  StoryTime,
  RelativeTime,
  TimelineChapterRef,
  TimelineEvent,
  TimelineInsertPosition,
  TimelineMarker,
} from '../../types/timeline'
import { TIMELINE_LEDGER_PATH } from '../../types/timeline'
import { rescanProject } from '../fs/project-fs'
import type { ElementType } from '../../types/rag'
import {
  buildTimelineView,
  createTimelinePointEvent,
  createTimelineSpanEvent,
  deleteTimelineEventEntry,
  queryTimelineEvents,
  updateTimelineEventEntry,
} from '../../services/timeline-service'
import type { TimelineView } from '../../services/timeline-service'
import type {
  TimelineCreateOutput,
  TimelineCreatePointInput,
  TimelineCreateSpanInput,
  TimelineDeleteInput,
  TimelineDeleteOutput,
  TimelineElementRefInput,
  TimelineEventDetailView,
  TimelineEventPatchInput,
  TimelineEventSummaryItem,
  TimelineListInput,
  TimelineListOutput,
  TimelineParticipantEntryInput,
  TimelinePositionInput,
  TimelineReadInput,
  TimelineReadOutput,
  TimelineUpdateInput,
  TimelineUpdateOutput,
  ToolDefinition,
} from './types'

/**
 * 时间线事件智能体工具（时间线 JSON 化施工计划阶段 2）。主 Agent 专属，要素管理员
 * 不装配（与关系/伏笔/节奏工具同一先例）。写入经时间线服务层（域内写锁 + 双版本
 * 冲突基线 + 变更通知，source='agent' 让时间轴刷新），并走 AI 写入确认链
 * （buildConfirmation 待改字段预览）与变更账本（extractFileChange / extractChangeDiff）。
 *
 * 只读三件套语义对齐关系工具：List 给摘要 + 引导语，Read 给单事件全量 + 局部上下文
 * （插入定位用），写入工具的输出把引用解析为名称（解析失败仍带 id，名称留空）。
 */

const TIMELINE_LIST_LIMIT = 50

const CORRUPT_MESSAGE = '时间线账本文件已损坏，读取与写入都被阻止；请提醒作者在时间轴弹窗中查看原始内容或重新初始化'

const NARRATIVE_MODES = ['current', 'recall', 'prophecy', 'dream'] as const

/** 携带详情的标记（point / start）：end 只回指不携带事件。 */
function isDetailMarker(marker: TimelineMarker): marker is Extract<TimelineMarker, { event: TimelineEvent }> {
  return marker.kind !== 'end'
}

/* ---------- 入参解析 ---------- */

function readOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readString(value, label)
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是数字`)
  }
  return value
}

function readInteger(value: unknown, label: string): number {
  const number = readNumber(value, label)
  if (!Number.isInteger(number)) {
    throw new Error(`${label} 必须是整数`)
  }
  return number
}

function readPosition(value: unknown, label: string): TimelineInsertPosition {
  const record = asRecord(value)
  const at = readString(record.at, `${label}.at`).trim()
  if (at === 'first' || at === 'last') {
    return { at }
  }
  if (at === 'before' || at === 'after') {
    const anchorMarkerId = readString(record.anchorMarkerId, `${label}.anchorMarkerId`).trim()
    if (!anchorMarkerId) {
      throw new Error(`${label}.at 为 ${at} 时必须提供 anchorMarkerId（TM- 开头，来自 TimelineList/TimelineRead 返回）`)
    }
    return { at, anchorMarkerId }
  }
  throw new Error(`${label}.at 必须是 first / last / before / after 之一`)
}

function readOptionalPosition(value: unknown, label: string): TimelineInsertPosition | undefined {
  return value === undefined ? undefined : readPosition(value, label)
}

/** 要素定位入参：稳定标识或「类型 + 精确名称」二选一（都给时以标识优先）。 */
function readElementSelector(value: unknown, label: string): TimelineElementSelector {
  const record = asRecord(value)
  const id = record.id === undefined ? undefined : readString(record.id, `${label}.id`).trim()
  if (id) {
    return { kind: 'element', id }
  }
  const type = record.type === undefined ? undefined : readString(record.type, `${label}.type`).trim()
  const name = record.name === undefined ? undefined : readString(record.name, `${label}.name`).trim()
  if (type !== undefined || name !== undefined) {
    if (!type || !name) {
      throw new Error(`${label} 按「类型 + 名称」定位时 type 与 name 都必须提供；已有稳定标识则传 id 即可`)
    }
    return { kind: 'element', type: type as ElementType, name }
  }
  throw new Error(`${label} 必须提供 id（稳定标识）或 type + name（类型与精确名称）之一`)
}

function readParticipant(value: unknown, label: string): TimelineParticipantInput {
  const selector = readElementSelector(value, label)
  const record = asRecord(value)
  const role = record.role === undefined ? undefined : readString(record.role, `${label}.role`)
  return { ...selector, ...(role !== undefined ? { role } : {}) }
}

function readStoryTime(value: unknown, label: string): StoryTime {
  const record = asRecord(value)
  const year = readNumber(record.year, `${label}.year`)
  const out: StoryTime = { year }
  const calendar = readOptionalString(record.calendar, `${label}.calendar`)
  if (calendar !== undefined) {
    out.calendar = calendar
  }
  const season = readOptionalString(record.season, `${label}.season`)
  if (season !== undefined) {
    out.season = season
  }
  if (record.month !== undefined) {
    out.month = readInteger(record.month, `${label}.month`)
  }
  if (record.day !== undefined) {
    out.day = readInteger(record.day, `${label}.day`)
  }
  return out
}

function readRelativeTime(value: unknown, label: string): RelativeTime {
  const record = asRecord(value)
  const anchorEventId = readString(record.anchorEventId, `${label}.anchorEventId`).trim()
  if (!anchorEventId) {
    throw new Error(`${label}.anchorEventId 不能为空（EVT- 开头，来自 TimelineList/TimelineRead 返回）`)
  }
  const offset = readNumber(record.offset, `${label}.offset`)
  const unit = readString(record.unit, `${label}.unit`).trim()
  if (!unit) {
    throw new Error(`${label}.unit 不能为空；用短词（如 day / month / year / era）`)
  }
  const direction = readString(record.direction, `${label}.direction`).trim()
  if (direction !== 'before' && direction !== 'after') {
    throw new Error(`${label}.direction 必须是 before / after 之一`)
  }
  return { anchorEventId, offset, unit, direction }
}

function readChapterRef(value: unknown, label: string): TimelineChapterRef {
  const record = asRecord(value)
  const chapterNumber = readInteger(record.chapterNumber, `${label}.chapterNumber`)
  if (chapterNumber <= 0) {
    throw new Error(`${label}.chapterNumber 必须是正整数（全本章号，按位置引用）`)
  }
  const mode = readString(record.mode, `${label}.mode`).trim()
  if (!(NARRATIVE_MODES as readonly string[]).includes(mode)) {
    throw new Error(`${label}.mode 必须是 ${NARRATIVE_MODES.join(' / ')} 之一（区分故事内发生与读者读到）`)
  }
  return { chapterNumber, mode: mode as TimelineChapterRef['mode'] }
}

function readIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  const ids = value.map((item, index) => readString(item, `${label}[${index}]`).trim())
  if (ids.some((id) => !id)) {
    throw new Error(`${label} 不能包含空标识`)
  }
  return ids
}

/** 事件详情入参（create 必填校验在领域层；update 语义 undefined = 不改动、null = 清空）。 */
function readEventPatch(value: unknown, label: string): TimelineEventPatchInput {
  const record = asRecord(value)
  const out: TimelineEventPatchInput = {}

  if (record.title !== undefined) {
    out.title = readString(record.title, `${label}.title`)
  }
  if (record.summary !== undefined) {
    out.summary = readString(record.summary, `${label}.summary`)
  }
  if (record.storyTime !== undefined) {
    out.storyTime = record.storyTime === null ? null : readStoryTime(record.storyTime, `${label}.storyTime`)
  }
  if (record.relativeTime !== undefined) {
    out.relativeTime = record.relativeTime === null ? null : readRelativeTime(record.relativeTime, `${label}.relativeTime`)
  }
  if (record.participants !== undefined) {
    if (!Array.isArray(record.participants)) {
      throw new Error(`${label}.participants 必须是数组`)
    }
    out.participants = record.participants.map((item, index) => readParticipant(item, `${label}.participants[${index}]`))
  }
  if (record.plots !== undefined) {
    if (!Array.isArray(record.plots)) {
      throw new Error(`${label}.plots 必须是数组`)
    }
    out.plots = record.plots.map((item, index) => readElementSelector(item, `${label}.plots[${index}]`))
  }
  if (record.chapters !== undefined) {
    if (!Array.isArray(record.chapters)) {
      throw new Error(`${label}.chapters 必须是数组`)
    }
    out.chapters = record.chapters.map((item, index) => readChapterRef(item, `${label}.chapters[${index}]`))
  }
  if (record.causedBy !== undefined) {
    out.causedBy = readIdList(record.causedBy, `${label}.causedBy`)
  }
  return out
}

/* ---------- 平面入参 → 领域输入 ---------- */

/** 入参是平面形态（validateInput 已按领域形状产出，这里恢复判别结构供领域层消费）。 */
function toDomainPosition(position: TimelinePositionInput | undefined): TimelineInsertPosition {
  if (!position || position.at === 'last') {
    return { at: 'last' }
  }
  if (position.at === 'first') {
    return { at: 'first' }
  }
  return { at: position.at, anchorMarkerId: position.anchorMarkerId ?? '' }
}

function toDomainSelector(ref: TimelineElementRefInput): TimelineElementSelector {
  return readElementSelector(ref, '事件要素引用')
}

function toDomainPatch(patch: TimelineEventPatchInput) {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.storyTime !== undefined ? { storyTime: patch.storyTime } : {}),
    ...(patch.relativeTime !== undefined ? { relativeTime: patch.relativeTime } : {}),
    ...(patch.participants !== undefined
      ? { participants: patch.participants.map((participant) => ({ ...toDomainSelector(participant), ...(participant.role !== undefined ? { role: participant.role } : {}) })) }
      : {}),
    ...(patch.plots !== undefined ? { plots: patch.plots.map(toDomainSelector) } : {}),
    ...(patch.chapters !== undefined ? { chapters: patch.chapters } : {}),
    ...(patch.causedBy !== undefined ? { causedBy: patch.causedBy } : {}),
  }
}

/* ---------- 输出组装 ---------- */

type LoadedView = { document: Awaited<ReturnType<typeof queryTimelineEvents>>; view: TimelineView }

/** 读视图前先刷新文件树：runtime.project.tree 可能是打开项目时的陈旧快照。 */
async function loadView(project: Parameters<typeof queryTimelineEvents>[0]): Promise<LoadedView> {
  try {
    const snapshot = { ...project, tree: await rescanProject(project) }
    const document = await queryTimelineEvents(snapshot, {})
    const view = await buildTimelineView(snapshot, document)
    return { document, view }
  } catch (error) {
    if (error instanceof TimelineCorruptError) {
      throw new Error(CORRUPT_MESSAGE)
    }
    throw error
  }
}

/** 全账本 id → 名称映射（输出渲染用；只收已解析引用，解析失败名称留空）。 */
function elementNameMap(view: TimelineView): Map<string, { name: string; type: string }> {
  const map = new Map<string, { name: string; type: string }>()
  if (view.status !== 'ok') {
    return map
  }
  for (const item of view.markers) {
    if (!item.refs) {
      continue
    }
    const referenced = [...item.refs.participants, ...item.refs.plots].map((entry) => entry.view)
    for (const element of referenced) {
      if (element.status === 'resolved' && !map.has(element.id)) {
        map.set(element.id, { name: element.name, type: element.type })
      }
    }
  }
  return map
}

function eventTitles(view: TimelineView): Map<string, string> {
  const titles = new Map<string, string>()
  if (view.status !== 'ok') {
    return titles
  }
  for (const { marker } of view.markers) {
    if (marker.kind !== 'end') {
      titles.set(marker.eventId, marker.event.title)
    }
  }
  return titles
}

/** 事件详情 → 模型友好视图（引用解析为名称；解析失败 name 为空串）。 */
function detailView(event: TimelineEvent, names: ReadonlyMap<string, { name: string; type: string }>): TimelineEventDetailView {
  return {
    title: event.title,
    summary: event.summary,
    storyTime: event.storyTime,
    relativeTime: event.relativeTime,
    participants: event.participants.map((participant) => ({
      id: participant.id,
      name: names.get(participant.id)?.name ?? '',
      type: names.get(participant.id)?.type ?? '',
      role: participant.role ?? '',
    })),
    plots: event.plotIds.map((id) => ({ id, name: names.get(id)?.name ?? '' })),
    chapters: event.chapters,
    causedBy: event.causedBy,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }
}

function summaryItem(
  marker: Extract<TimelineMarker, { event: TimelineEvent }>,
  ordinal: number,
  names: ReadonlyMap<string, { name: string; type: string }>,
): TimelineEventSummaryItem {
  const event = marker.event
  return {
    eventId: marker.eventId,
    markerId: marker.id,
    kind: marker.kind === 'point' ? 'point' : 'span',
    ordinal,
    title: event.title,
    summary: event.summary,
    storyTime: event.storyTime,
    relativeTime: event.relativeTime,
    participants: event.participants.map((participant) => ({
      id: participant.id,
      name: names.get(participant.id)?.name ?? '',
      type: names.get(participant.id)?.type ?? '',
      role: participant.role ?? '',
    })),
    plots: event.plotIds.map((id) => ({ id, name: names.get(id)?.name ?? '' })),
    chapters: event.chapters,
    causedBy: event.causedBy,
  }
}

function eventJson(detail: TimelineEventDetailView, eventId: string): string {
  return JSON.stringify({ eventId, ...detail }, null, 2)
}

/** 懒分配标识写回的要素文件：作为附带变更进变更账本（编辑器与文件树据此刷新）。 */
function assignedIdChanges(assigned: readonly { sourcePath: string }[]) {
  return assigned.map((item) => ({ type: 'updated' as const, path: item.sourcePath }))
}

/* ---------- 展示文案 ---------- */

function describeSelector(selector: TimelineElementRefInput): string {
  if (selector.id) {
    return selector.id
  }
  if (selector.type && selector.name) {
    return `${selector.name}（${selector.type}）`
  }
  return '未定位的要素'
}

function describePosition(position: TimelinePositionInput | undefined): string {
  if (!position || position.at === 'last') {
    return '列表末尾'
  }
  if (position.at === 'first') {
    return '列表开头'
  }
  return `标记 ${position.anchorMarkerId} ${position.at === 'before' ? '之前' : '之后'}`
}

function describeStoryTime(time: StoryTime | null | undefined): string {
  if (!time) {
    return '（纯顺序，无明确时间）'
  }
  const calendar = time.calendar ? `${time.calendar}` : ''
  const season = time.season ? ` ${time.season}` : ''
  const month = time.month !== undefined ? ` ${time.month}月` : ''
  const day = time.day !== undefined ? ` ${time.day}日` : ''
  return `${calendar}${time.year}年${season}${month}${day}`.trim() || `${time.year}年`
}

function describeRelativeTime(time: RelativeTime | null | undefined): string {
  if (!time) {
    return ''
  }
  return `相对 ${time.anchorEventId} ${time.direction === 'before' ? '前' : '后'} ${time.offset} ${time.unit}`
}

function confirmationContent(event: TimelineEventPatchInput, positionLine: string): string {
  const participants = event.participants?.map((participant) => describeSelector(participant) + (participant.role ? `（${participant.role}）` : '')).join('、')
  const plots = event.plots?.map((plot) => describeSelector(plot)).join('、')
  const chapters = event.chapters?.map((ref) => `第${ref.chapterNumber}章（${ref.mode}）`).join('、')
  return [
    `${event.title ? `事件标题：${event.title.trim()}` : ''}`,
    `明确时间：${event.storyTime === null ? '（清除）' : describeStoryTime(event.storyTime)}`,
    event.relativeTime !== undefined ? `相对时间：${event.relativeTime === null ? '（清除）' : describeRelativeTime(event.relativeTime)}` : '',
    event.summary !== undefined ? `摘要：${event.summary.trim() || '（清空）'}` : '',
    participants !== undefined ? `参与者：${participants || '（清空）'}` : '',
    plots !== undefined ? `关联情节：${plots || '（清空）'}` : '',
    chapters !== undefined ? `章节：${chapters || '（清空）'}` : '',
    event.causedBy !== undefined ? `因果前驱：${event.causedBy.join('、') || '（清空）'}` : '',
    positionLine,
  ].filter(Boolean).join('\n')
}

/* ---------- 只读工具 ---------- */

export const timelineListTool: ToolDefinition<'TimelineList', TimelineListInput, TimelineListOutput> = {
  name: 'TimelineList',
  description: '列出时间线事件账本中的事件（按故事内顺序），可按参与者、情节、章号或年份范围筛选。返回带要素名称的摘要；区间事件只出现一次。写场景前先查相关事件，不要凭记忆编时间线。',
  validateInput(input) {
    const value = asRecord(input)
    const participantElementId = readOptionalString(value.participantElementId, 'TimelineList.participantElementId')?.trim()
    const participantElementIds = value.participantElementIds === undefined
      ? undefined
      : readIdList(value.participantElementIds, 'TimelineList.participantElementIds')
    const plotId = readOptionalString(value.plotId, 'TimelineList.plotId')?.trim()
    const chapterNumber = value.chapterNumber === undefined ? undefined : readInteger(value.chapterNumber, 'TimelineList.chapterNumber')
    const yearFrom = value.yearFrom === undefined ? undefined : readInteger(value.yearFrom, 'TimelineList.yearFrom')
    const yearTo = value.yearTo === undefined ? undefined : readInteger(value.yearTo, 'TimelineList.yearTo')
    return {
      ...(participantElementId ? { participantElementId } : {}),
      ...(participantElementIds !== undefined ? { participantElementIds } : {}),
      ...(plotId ? { plotId } : {}),
      ...(chapterNumber !== undefined ? { chapterNumber } : {}),
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(yearTo !== undefined ? { yearTo } : {}),
    }
  },
  async run(input, runtime) {
    const { view } = await loadView(runtime.project)
    const names = elementNameMap(view)

    const idFilter = input.participantElementId !== undefined
      ? new Set([input.participantElementId])
      : input.participantElementIds !== undefined
        ? new Set(input.participantElementIds)
        : null
    const items: TimelineEventSummaryItem[] = []
    view.markers.forEach((item) => {
      if (item.marker.kind === 'end') {
        return
      }
      const event = item.marker.event
      if (idFilter && !event.participants.some((participant) => idFilter.has(participant.id))) {
        return
      }
      if (input.plotId !== undefined && !event.plotIds.includes(input.plotId)) {
        return
      }
      if (input.chapterNumber !== undefined && !event.chapters.some((ref) => ref.chapterNumber === input.chapterNumber)) {
        return
      }
      const year = event.storyTime?.year
      if (input.yearFrom !== undefined && (year === null || year === undefined || year < input.yearFrom)) {
        return
      }
      if (input.yearTo !== undefined && (year === null || year === undefined || year > input.yearTo)) {
        return
      }
      items.push(summaryItem(item.marker, item.ordinal, names))
    })

    const truncated = items.length > TIMELINE_LIST_LIMIT
    const limited = truncated ? items.slice(0, TIMELINE_LIST_LIMIT) : items
    const hasIssues = view.issues.length > 0
    const hasFilter = Object.keys(input).length > 0
    const base = items.length > 0
      ? `共 ${items.length} 个事件（列表顺序即故事内顺序）。定位新事件位置用 markerId 锚定；写对手戏前建议按参与者筛选取相关事件`
      : hasFilter
        ? '当前筛选条件下没有匹配事件；放宽条件或用无参 TimelineList 查看全部事件'
        : '账本还没有事件。正文写到新发生的关键事件时用 TimelineCreatePoint / TimelineCreateSpan 登记；时间线与正文互为印证'
    return {
      events: limited,
      totalCount: items.length,
      truncated,
      guidance: base
        + (truncated ? `；仅返回前 ${TIMELINE_LIST_LIMIT} 个，可加筛选条件缩小范围` : '')
        + (hasIssues ? `；注意：账本存在 ${view.issues.length} 条异常数据（格式非法或配对破坏），写入被阻止，请提醒作者在时间轴中清理` : ''),
    }
  },
  summarizeInput(input) {
    const parts = [
      input.participantElementId ? `参与者=${input.participantElementId}` : '',
      input.participantElementIds ? `参与者=${input.participantElementIds.length} 个` : '',
      input.plotId ? `情节=${input.plotId}` : '',
      input.chapterNumber ? `第${input.chapterNumber}章` : '',
      input.yearFrom !== undefined || input.yearTo !== undefined ? `年份 ${input.yearFrom ?? '?'}–${input.yearTo ?? '?'}` : '',
    ].filter(Boolean)
    return `列出时间线事件${parts.length > 0 ? `（${parts.join('，')}）` : ''}`
  },
  summarizeOutput(output) {
    return `账本共 ${output.totalCount} 个事件${output.truncated ? `，返回前 ${output.events.length} 个` : ''}`
  },
}

export const timelineReadTool: ToolDefinition<'TimelineRead', TimelineReadInput, TimelineReadOutput> = {
  name: 'TimelineRead',
  description: '按事件标识读取一个事件的完整内容（标题、时间、参与者、情节、章节、因果前驱），并返回事件在列表中的前后局部上下文（插入定位用）。同时返回事件版本令牌与账本基线哈希（TimelineUpdate 冲突判定用）。',
  validateInput(input) {
    const value = asRecord(input)
    const eventId = readString(value.eventId, 'TimelineRead.eventId').trim()
    if (!eventId) {
      throw new Error('TimelineRead.eventId 不能为空')
    }
    const contextCount = value.contextCount === undefined ? undefined : readInteger(value.contextCount, 'TimelineRead.contextCount')
    if (contextCount !== undefined && contextCount < 1) {
      throw new Error('TimelineRead.contextCount 必须是正整数')
    }
    return { eventId, ...(contextCount !== undefined ? { contextCount } : {}) }
  },
  async run(input, runtime) {
    const { document, view } = await loadView(runtime.project)

    const index = document.markers.findIndex(
      (marker) => isDetailMarker(marker) && marker.eventId === input.eventId,
    )
    if (index === -1) {
      return { notFound: true as const, eventId: input.eventId }
    }
    const anchor = document.markers[index]!
    if (!isDetailMarker(anchor)) {
      return { notFound: true as const, eventId: input.eventId }
    }
    const names = elementNameMap(view)
    const titles = eventTitles(view)

    const count = Math.max(1, Math.min(input.contextCount ?? 3, 30))
    const before = timelineMarkerContext(document, anchor.id, 'before', count)
    const after = timelineMarkerContext(document, anchor.id, 'after', count)
    const neighbors = [...before.markers, ...after.markers.slice(1)].map((neighbor, position) => ({
      markerId: neighbor.id,
      eventId: neighbor.eventId,
      kind: neighbor.kind,
      title: isDetailMarker(neighbor) ? neighbor.event.title : '',
      ordinal: index - (before.markers.length - 1) + position + 1,
    }))

    const causedByTitles = anchor.event.causedBy.map((id) => titles.get(id) ?? null)
    return {
      eventId: anchor.eventId,
      markerId: anchor.id,
      kind: anchor.kind === 'point' ? 'point' : 'span',
      event: detailView(anchor.event, names),
      version: timelineEventVersion(anchor.event),
      causedByTitles,
      relativeAnchorTitle: anchor.event.relativeTime
        ? titles.get(anchor.event.relativeTime.anchorEventId) ?? null
        : undefined,
      neighbors,
      contentHash: document.contentHash,
    }
  },
  summarizeInput(input) {
    return `读取事件 ${input.eventId}`
  },
  summarizeOutput(output) {
    return 'notFound' in output
      ? `事件 ${output.eventId} 不存在`
      : `已读取事件 ${output.eventId}（${output.event.title}，前后上下文 ${output.neighbors.length} 条标记）`
  },
}

/* ---------- 写入工具 ---------- */

export const timelineCreatePointTool: ToolDefinition<'TimelineCreatePoint', TimelineCreatePointInput, TimelineCreateOutput> = {
  name: 'TimelineCreatePoint',
  description: '登记一个点事件（瞬间发生：遭遇、决定、死亡）。event.title 必填；时间三态可选（明确时间 / 相对时间 / 都不填=纯顺序）。position 用 first/last 或锚定某标记前后，缺省追加到末尾。',
  validateInput(input) {
    const value = asRecord(input)
    const event = readEventPatch(value.event, 'TimelineCreatePoint.event')
    if (!event.title?.trim()) {
      throw new Error('TimelineCreatePoint.event.title 不能为空；用一句话概括这个事件')
    }
    const position = readOptionalPosition(value.position, 'TimelineCreatePoint.position')
    return { event, ...(position !== undefined ? { position } : {}) }
  },
  async run(input, runtime) {
    const result = await createTimelinePointEvent(
      runtime.project.id,
      {
        event: toDomainPatch(input.event),
        position: toDomainPosition(input.position),
      },
      'agent',
    )
    if (result.marker.kind === 'end') {
      throw new Error('时间线领域返回了意外的结束标记')
    }
    const diff = countDiffLines('', eventJson(detailView(result.marker.event, new Map()), result.marker.eventId))
    return {
      eventId: result.marker.eventId,
      markerId: result.marker.id,
      endMarkerId: '',
      kind: 'point',
      title: result.marker.event.title,
      created: result.created,
      sourcePath: TIMELINE_LEDGER_PATH,
      contentHash: result.contentHash,
      assignedElementIds: result.assignedElementIds,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    return `登记点事件「${input.event.title?.trim()}」（位置：${describePosition(input.position)}）`
  },
  summarizeOutput(output) {
    const assigned = output.assignedElementIds.length > 0
      ? `；为 ${output.assignedElementIds.length} 个要素首次分配了稳定标识`
      : ''
    return `已登记点事件 ${output.eventId}（${output.title}）${assigned}`
  },
  extractFileChange(output) {
    return output.created
      ? { type: 'created' as const, path: TIMELINE_LEDGER_PATH }
      : { type: 'updated' as const, path: TIMELINE_LEDGER_PATH }
  },
  extractExtraFileChanges(output) {
    return assignedIdChanges(output.assignedElementIds)
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: eventJson(
        { title: output.title, summary: '', storyTime: null, relativeTime: null, participants: [], plots: [], chapters: [], causedBy: [], createdAt: '', updatedAt: '' },
        output.eventId,
      ),
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    return {
      kind: 'create' as const,
      path: TIMELINE_LEDGER_PATH,
      content: confirmationContent(input.event, `位置：${describePosition(input.position)}`),
    }
  },
}

export const timelineCreateSpanTool: ToolDefinition<'TimelineCreateSpan', TimelineCreateSpanInput, TimelineCreateOutput> = {
  name: 'TimelineCreateSpan',
  description: '登记一个区间事件（持续一段故事时间：战争、旅途、修行）。startPosition 与 endPosition 分别锚定开始/结束标记的落点，结束必须在开始之后（可跨任意多事件，表达并行与嵌套）。event.title 必填。',
  validateInput(input) {
    const value = asRecord(input)
    const event = readEventPatch(value.event, 'TimelineCreateSpan.event')
    if (!event.title?.trim()) {
      throw new Error('TimelineCreateSpan.event.title 不能为空；用一句话概括这个事件')
    }
    const startPosition = readPosition(value.startPosition, 'TimelineCreateSpan.startPosition')
    const endPosition = readPosition(value.endPosition, 'TimelineCreateSpan.endPosition')
    return { event: { ...event, title: event.title.trim() }, startPosition, endPosition }
  },
  async run(input, runtime) {
    const result = await createTimelineSpanEvent(
      runtime.project.id,
      {
        event: toDomainPatch(input.event),
        startPosition: toDomainPosition(input.startPosition),
        endPosition: toDomainPosition(input.endPosition),
      },
      'agent',
    )
    if (result.marker.kind !== 'start' || !result.endMarker) {
      throw new Error('时间线领域返回了不完整的区间标记对')
    }
    const diff = countDiffLines('', eventJson(detailView(result.marker.event, new Map()), result.marker.eventId))
    return {
      eventId: result.marker.eventId,
      markerId: result.marker.id,
      endMarkerId: result.endMarker.id,
      kind: 'span',
      title: result.marker.event.title,
      created: result.created,
      sourcePath: TIMELINE_LEDGER_PATH,
      contentHash: result.contentHash,
      assignedElementIds: result.assignedElementIds,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    return `登记区间事件「${input.event.title?.trim()}」（${describePosition(input.startPosition)} → ${describePosition(input.endPosition)}）`
  },
  summarizeOutput(output) {
    const assigned = output.assignedElementIds.length > 0
      ? `；为 ${output.assignedElementIds.length} 个要素首次分配了稳定标识`
      : ''
    return `已登记区间事件 ${output.eventId}（${output.title}）${assigned}`
  },
  extractFileChange(output) {
    return output.created
      ? { type: 'created' as const, path: TIMELINE_LEDGER_PATH }
      : { type: 'updated' as const, path: TIMELINE_LEDGER_PATH }
  },
  extractExtraFileChanges(output) {
    return assignedIdChanges(output.assignedElementIds)
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: eventJson(
        { title: output.title, summary: '', storyTime: null, relativeTime: null, participants: [], plots: [], chapters: [], causedBy: [], createdAt: '', updatedAt: '' },
        output.eventId,
      ),
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    return {
      kind: 'create' as const,
      path: TIMELINE_LEDGER_PATH,
      content: confirmationContent(input.event, `开始位置：${describePosition(input.startPosition)}；结束位置：${describePosition(input.endPosition)}`),
    }
  },
}

export const timelineUpdateTool: ToolDefinition<'TimelineUpdate', TimelineUpdateInput, TimelineUpdateOutput> = {
  name: 'TimelineUpdate',
  description: '按事件标识修改一个事件的详情字段（标题、摘要、时间、参与者、情节、章节、因果前驱）。至少提供一项；传 null 清空可空时间字段。持有 TimelineRead 返回的 contentHash 时传入可做并发冲突检测。',
  validateInput(input) {
    const value = asRecord(input)
    const eventId = readString(value.eventId, 'TimelineUpdate.eventId').trim()
    if (!eventId) {
      throw new Error('TimelineUpdate.eventId 不能为空')
    }
    const expectedContentHash = readOptionalString(value.expectedContentHash, 'TimelineUpdate.expectedContentHash')?.trim()
    // 字段在入参上是展平的（title / summary / … 顶层），readEventPatch 按同名字段读取
    const patch = readEventPatch(value, 'TimelineUpdate')
    if (Object.keys(patch).length === 0) {
      throw new Error('TimelineUpdate 至少提供 title、summary、storyTime、relativeTime、participants、plots、chapters、causedBy 中要修改的一项')
    }
    return {
      eventId,
      ...(expectedContentHash ? { expectedContentHash } : {}),
      ...patch,
    }
  },
  async run(input, runtime) {
    const { eventId, expectedContentHash, ...flat } = input
    const result = await updateTimelineEventEntry(
      runtime.project.id,
      {
        eventId,
        patch: toDomainPatch(flat),
        ...(expectedContentHash !== undefined ? { expectedContentHash } : {}),
      },
      'agent',
    )
    if (result.marker.kind === 'end') {
      throw new Error('时间线领域返回了意外的结束标记')
    }

    const { view } = await loadView(runtime.project)
    const names = elementNameMap(view)
    const current = detailView(result.marker.event, names)
    const previous = detailView(result.previous, names)
    const diff = countDiffLines(eventJson(previous, input.eventId), eventJson(current, input.eventId))
    return {
      eventId: input.eventId,
      title: result.marker.event.title,
      event: current,
      previous,
      contentHash: result.contentHash,
      assignedElementIds: result.assignedElementIds,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    const parts = [
      input.title !== undefined ? `标题→${input.title.trim() || '（清空）'}` : '',
      input.summary !== undefined ? '摘要' : '',
      input.storyTime !== undefined ? (input.storyTime === null ? '明确时间→清除' : '明确时间') : '',
      input.relativeTime !== undefined ? (input.relativeTime === null ? '相对时间→清除' : '相对时间') : '',
      input.participants !== undefined ? '参与者' : '',
      input.plots !== undefined ? '情节' : '',
      input.chapters !== undefined ? '章节' : '',
      input.causedBy !== undefined ? '因果前驱' : '',
    ].filter(Boolean)
    return `修改事件 ${input.eventId}（${parts.join('，')}）`
  },
  summarizeOutput(output) {
    return `已修改事件 ${output.eventId}（${output.title}）`
  },
  extractFileChange() {
    return { type: 'updated' as const, path: TIMELINE_LEDGER_PATH }
  },
  extractExtraFileChanges(output) {
    return assignedIdChanges(output.assignedElementIds)
  },
  extractChangeDiff(output) {
    return {
      oldText: eventJson(output.previous, output.eventId),
      newText: eventJson(output.event, output.eventId),
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    const parts = [
      input.title !== undefined ? `标题 → ${input.title.trim() || '（清空）'}` : '',
      input.summary !== undefined ? `摘要 → ${input.summary.trim() || '（清空）'}` : '',
      input.storyTime !== undefined ? `明确时间 → ${input.storyTime === null ? '（清除）' : describeStoryTime(input.storyTime)}` : '',
      input.relativeTime !== undefined ? `相对时间 → ${input.relativeTime === null ? '（清除）' : describeRelativeTime(input.relativeTime)}` : '',
      input.participants !== undefined ? `参与者 → ${input.participants.map((participant) => describeSelector(participant) + (participant.role ? `（${participant.role}）` : '')).join('、') || '（清空）'}` : '',
      input.plots !== undefined ? `关联情节 → ${input.plots.map((plot) => describeSelector(plot)).join('、') || '（清空）'}` : '',
      input.chapters !== undefined ? `章节 → ${input.chapters.map((ref) => `第${ref.chapterNumber}章（${ref.mode}）`).join('、') || '（清空）'}` : '',
      input.causedBy !== undefined ? `因果前驱 → ${input.causedBy.join('、') || '（清空）'}` : '',
    ].filter(Boolean)
    return {
      kind: 'edit' as const,
      path: TIMELINE_LEDGER_PATH,
      oldText: '（事件字段更新，差异以执行结果为准）',
      newText: parts.join('\n'),
    }
  },
}

export const timelineDeleteTool: ToolDefinition<'TimelineDelete', TimelineDeleteInput, TimelineDeleteOutput> = {
  name: 'TimelineDelete',
  description: '按事件标识删除一个事件（区间事件两端同删）。其他事件 causedBy 中指向它的引用自动级联清除；仍以它为相对时间锚的事件保留锚并在输出中提示（待作者改绑）。只在登记错误或用户明确要求时使用。',
  validateInput(input) {
    const value = asRecord(input)
    const eventId = readString(value.eventId, 'TimelineDelete.eventId').trim()
    if (!eventId) {
      throw new Error('TimelineDelete.eventId 不能为空')
    }
    return { eventId }
  },
  async run(input, runtime) {
    // 删除前先读视图：标题、区间形态与相对锚依赖（删除后查不到）
    const { view } = await loadView(runtime.project)
    const targetIndex = view.markers.findIndex(
      (item) => isDetailMarker(item.marker) && item.marker.eventId === input.eventId,
    )
    if (targetIndex === -1) {
      throw new Error(`事件 ${input.eventId} 不存在；可能已被删除，请用 TimelineList 重新查询`)
    }
    const target = view.markers[targetIndex]!
    if (!isDetailMarker(target.marker)) {
      throw new Error(`事件 ${input.eventId} 不存在；可能已被删除，请用 TimelineList 重新查询`)
    }
    const targetEvent = target.marker.event
    const anchoredEvents = view.markers
      .filter((item) => isDetailMarker(item.marker) && item.marker.event.relativeTime?.anchorEventId === input.eventId)
      .map((item) => ({ eventId: item.marker.eventId, title: isDetailMarker(item.marker) ? item.marker.event.title : '' }))

    const result = await deleteTimelineEventEntry(runtime.project.id, input.eventId, 'agent')
    const diff = countDiffLines(eventJson(detailView(targetEvent, new Map()), input.eventId), '')
    return {
      eventId: input.eventId,
      title: targetEvent.title,
      kind: result.removed.some((marker) => marker.kind === 'start') ? 'span' : 'point',
      removedMarkers: result.removed.length,
      cascadedCausedBy: result.cascadedCausedBy,
      anchoredEvents,
      linesAdded: 0,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    return `删除事件 ${input.eventId}`
  },
  summarizeOutput(output) {
    const anchorNote = output.anchoredEvents.length > 0
      ? `；仍有 ${output.anchoredEvents.length} 个事件以它为相对时间锚（已提示改绑）`
      : ''
    return `已删除${output.kind === 'span' ? '区间' : '点'}事件 ${output.eventId}（${output.title}）${anchorNote}`
  },
  extractFileChange() {
    return { type: 'updated' as const, path: TIMELINE_LEDGER_PATH }
  },
  extractChangeDiff(output) {
    return {
      oldText: eventJson(
        { title: output.title, summary: '', storyTime: null, relativeTime: null, participants: [], plots: [], chapters: [], causedBy: [], createdAt: '', updatedAt: '' },
        output.eventId,
      ),
      newText: '',
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    // 与关系/计划同一先例：路径带上条目标识，确认界面据账本前缀改用「删除一条事件」文案
    return {
      kind: 'delete' as const,
      path: `${TIMELINE_LEDGER_PATH}（事件 ${input.eventId}）`,
    }
  },
}
