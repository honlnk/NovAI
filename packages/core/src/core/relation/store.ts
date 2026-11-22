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
import { rescanProject } from '../fs/project-fs'
import { loadTimelineLedger, TimelineCorruptError } from '../timeline/store'
import { hashContent } from '../util/hash'

import type { ElementReferenceEntry, ElementReferenceIndex } from '../elements/reference-index'
import type { ProjectSnapshot } from '../../types/project'
import type { ElementType } from '../../types/rag'
import type { TimelineEvent, TimelineMarker } from '../../types/timeline'
import type {
  RelationLayoutMap,
  RelationLedgerDocument,
  RelationLedgerIssue,
  RelationNodeRef,
  RelationRecord,
} from '../../types/relation'
import { RELATION_ELEMENT_NODE_TYPES, RELATION_LEDGER_PATH, RELATION_LEDGER_VERSION } from '../../types/relation'

/**
 * 关系领域核心（关系图谱施工计划 §四）：账本读写、域内写锁、校验（引用/自环/重复/
 * 节点类型）、CRUD、查询、坐标重基保存与悬空引用级联。所有结构写入携带预期内容
 * 哈希；坐标写入走「重基合并」（只替换 layout，冲突自动重试一次）。
 *
 * 懒分配标识：首次引用某要素时 ensureElementId 写回 frontmatter；改名是纯文件移动，
 * 既有引用天然不受影响。
 */

/** 领域错误（可修复的校验拒绝）。 */
export class RelationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelationError'
  }
}

/** 写入版本冲突（磁盘与预期版本不一致），携带磁盘当前哈希供上层重读或上抛冲突界面。 */
export class RelationConflictError extends RelationError {
  readonly currentContentHash: string | null

  constructor(currentContentHash: string | null) {
    super(
      currentContentHash === null
        ? `关系账本已不存在，本次操作基于的版本已过期；请重新读取后再试`
        : `关系账本已被其他操作修改，本次操作基于的版本已过期；请重新读取后再试`,
    )
    this.name = 'RelationConflictError'
    this.currentContentHash = currentContentHash
  }
}

/** 账本损坏：携带原始内容供界面只读呈现；恢复只能走「副本入回收站 + 重新初始化」。 */
export class RelationCorruptError extends RelationError {
  readonly raw: string

  constructor(raw: string, reason: string) {
    super(`关系账本已损坏（${reason}），不会自动覆盖；请在关系图谱中查看原始内容或重新初始化`)
    this.name = 'RelationCorruptError'
    this.raw = raw
  }
}

/* ---------- 域内写锁：单项目所有账本写入串行（UI、工具、坐标共用一条链） ---------- */

const writeLocks = new Map<string, Promise<unknown>>()

async function withRelationWriteLock<T>(project: ProjectSnapshot, operation: () => Promise<T>): Promise<T> {
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
 * 读取关系账本。文件不存在 → 空账本文档（contentHash = null，首次写入按新建语义）；
 * 结构性损坏（JSON/根结构/版本）→ RelationCorruptError；单条非法数据不丢弃文件，
 * 隔离进 issues（写入被阻止直至清理）。
 */
export async function loadRelationLedger(project: ProjectSnapshot): Promise<RelationLedgerDocument> {
  let document: { ledger: { relations: RelationRecord[]; layout: RelationLayoutMap; issues: RelationLedgerIssue[] }; contentHash: string } | null
  try {
    document = await readJsonLedger({
      project,
      path: RELATION_LEDGER_PATH,
      revive: reviveRelationLedger,
    })
  } catch (error) {
    if (error instanceof JsonLedgerCorruptError) {
      throw new RelationCorruptError(error.raw, error.reason)
    }
    throw error
  }

  if (!document) {
    return { relations: [], layout: {}, issues: [], contentHash: null }
  }

  return {
    relations: document.ledger.relations,
    layout: document.ledger.layout,
    issues: document.ledger.issues,
    contentHash: document.contentHash,
  }
}

/** revive：根结构/版本校验 + 单条数据校验（非法条目隔离为 issue，不抛错不丢弃）。 */
function reviveRelationLedger(raw: unknown): { relations: RelationRecord[]; layout: RelationLayoutMap; issues: RelationLedgerIssue[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('根结构必须是对象')
  }

  const root = raw as Record<string, unknown>
  if (root.version !== RELATION_LEDGER_VERSION) {
    throw new Error(`不识别的账本版本：${String(root.version)}`)
  }

  const issues: RelationLedgerIssue[] = []
  const relations: RelationRecord[] = []

  if (Array.isArray(root.relations)) {
    const seenIds = new Set<string>()
    root.relations.forEach((item, index) => {
      const record = reviveRelationRecord(item)
      if (record && seenIds.has(record.id)) {
        // 重复 id：按 id 的改删会同时命中多条，后出现者隔离（首条照常可用）
        issues.push({
          kind: 'duplicate-relation-id',
          index,
          id: record.id,
          reason: `关系标识 ${record.id} 与前面的条目重复`,
          raw: item,
        })
      } else if (record) {
        seenIds.add(record.id)
        relations.push(record)
      } else {
        issues.push({
          kind: 'invalid-relation',
          index,
          reason: describeRelationRecord(item),
          raw: item,
        })
      }
    })
  } else {
    issues.push({ kind: 'invalid-relation', index: -1, reason: 'relations 不是数组', raw: root.relations })
  }

  const layout: RelationLayoutMap = {}
  if (typeof root.layout === 'object' && root.layout !== null && !Array.isArray(root.layout)) {
    for (const [key, value] of Object.entries(root.layout as Record<string, unknown>)) {
      if (isLayoutEntry(value)) {
        layout[key] = { x: value.x, y: value.y }
      } else {
        issues.push({ kind: 'invalid-layout-entry', key, reason: '坐标必须是 { x, y } 数字', raw: value })
      }
    }
  } else if (root.layout !== undefined) {
    issues.push({ kind: 'invalid-layout-entry', key: '', reason: 'layout 不是对象', raw: root.layout })
  }

  return { relations, layout, issues }
}

function reviveRelationRecord(raw: unknown): RelationRecord | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  const description = typeof record.description === 'string' ? record.description : ''
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : ''
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
  const from = reviveNodeRef(record.from)
  const to = reviveNodeRef(record.to)

  if (!id || !type || !from || !to || !createdAt || !updatedAt) {
    return null
  }

  return { id, from, to, type, description, createdAt, updatedAt }
}

function reviveNodeRef(raw: unknown): RelationNodeRef | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const ref = raw as Record<string, unknown>
  if ((ref.kind !== 'element' && ref.kind !== 'event') || typeof ref.id !== 'string' || !ref.id.trim()) {
    return null
  }
  return { kind: ref.kind, id: ref.id.trim() }
}

function isLayoutEntry(raw: unknown): raw is { x: number; y: number } {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }
  const entry = raw as Record<string, unknown>
  return typeof entry.x === 'number' && Number.isFinite(entry.x) && typeof entry.y === 'number' && Number.isFinite(entry.y)
}

function describeRelationRecord(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    return '条目不是对象'
  }
  const record = raw as Record<string, unknown>
  const missing: string[] = []
  if (typeof record.id !== 'string' || !record.id.trim()) missing.push('id')
  if (typeof record.type !== 'string' || !record.type.trim()) missing.push('type')
  if (!reviveNodeRef(record.from)) missing.push('from')
  if (!reviveNodeRef(record.to)) missing.push('to')
  if (typeof record.createdAt !== 'string' || !record.createdAt) missing.push('createdAt')
  if (typeof record.updatedAt !== 'string' || !record.updatedAt) missing.push('updatedAt')
  return missing.length > 0 ? `缺少或非法字段：${missing.join('、')}` : '字段格式不合法'
}

function serializeRelationLedger(document: RelationLedgerDocument, options: { preserveIssues?: boolean } = {}): string {
  let relations: unknown[] = document.relations
  let layout: Record<string, unknown> = document.layout
  if (options.preserveIssues && document.issues.length > 0) {
    // 原样写回隔离条目（按原位置插回），只有用户明确「清理」时才丢弃
    relations = [...document.relations]
    const relationIssues = document.issues
      .filter((issue): issue is Extract<RelationLedgerIssue, { index: number }> => 'index' in issue && issue.index >= 0)
      .sort((left, right) => left.index - right.index)
    for (const issue of relationIssues) {
      relations.splice(Math.min(issue.index, relations.length), 0, issue.raw)
    }
    layout = { ...document.layout }
    for (const issue of document.issues) {
      if (issue.kind === 'invalid-layout-entry' && issue.key && !(issue.key in layout)) {
        layout[issue.key] = issue.raw
      }
    }
  }
  return JSON.stringify(
    {
      version: RELATION_LEDGER_VERSION,
      relations,
      layout,
    },
    null,
    2,
  )
}

/** 结构性损坏（relations/layout 整体不是数组/对象）无法原样写回，任何写入都必须先清理。 */
function hasStructuralIssue(document: RelationLedgerDocument): boolean {
  return document.issues.some(
    (issue) => (issue.kind === 'invalid-relation' && issue.index < 0) || (issue.kind === 'invalid-layout-entry' && !issue.key),
  )
}

/** 结构写入存在非法条目时统一拒绝：不清理就把手工坏数据静默洗掉等于丢用户数据。 */
function assertWritable(document: RelationLedgerDocument): void {
  if (document.issues.length > 0) {
    throw new RelationError(
      `关系账本存在 ${document.issues.length} 条异常数据（重复或格式非法），写入已被阻止；`
      + '请先在关系图谱中查看并清理异常条目（或删除后重建），再继续登记或修改关系',
    )
  }
}

async function persistLedger(project: ProjectSnapshot, document: RelationLedgerDocument, options: { preserveIssues?: boolean } = {}): Promise<string> {
  try {
    const { contentHash } = await writeJsonLedger({
      project,
      path: RELATION_LEDGER_PATH,
      ledger: null,
      expectedContentHash: document.contentHash,
      serialize: () => serializeRelationLedger(document, options),
    })
    return contentHash
  } catch (error) {
    if (error instanceof JsonLedgerConflictError) {
      throw new RelationConflictError(error.currentContentHash)
    }
    throw error
  }
}

/** 结构性写入前刷新文件树并重建引用索引（新要素落盘后立即可被引用）。 */
async function freshReferenceIndex(project: ProjectSnapshot): Promise<{ snapshot: ProjectSnapshot; index: ElementReferenceIndex }> {
  const tree = await rescanProject(project)
  const snapshot = { ...project, tree }
  return { snapshot, index: await buildElementReferenceIndex(snapshot) }
}

/* ---------- 节点选择与解析 ---------- */

/** 已校验的节点选择器：稳定标识或「类型 + 精确名称」二选一；事件用时间线事件标识。 */
export type RelationNodeSelector =
  | { kind: 'element'; id: string }
  | { kind: 'element'; type: ElementType; name: string }
  /** 按要素文件路径定位（界面选择尚未分配标识的要素用） */
  | { kind: 'element'; sourcePath: string }
  /** 时间线事件端点（EVT- 标识，账本化时间线上线后开放） */
  | { kind: 'event'; eventId: string }

export type ResolvedNode =
  | {
      ref: RelationNodeRef
      kind: 'element'
      entry: ElementReferenceEntry
      /** 本次调用是否为其懒分配了新标识（变更呈现用） */
      assignedId: boolean
    }
  | {
      ref: RelationNodeRef
      kind: 'event'
      /** 事件端点不落要素文件，无引用索引条目，也无需懒分配标识 */
      entry: null
      assignedId: false
    }

/**
 * 只读解析节点（不写盘）：校验存在性、唯一性与节点类型。
 * 懒分配标识必须等全部校验通过后再做（assignNodeId），否则失败的调用也会改写要素文件。
 */
export function locateRelationNode(index: ElementReferenceIndex, selector: RelationNodeSelector): ElementReferenceEntry {
  if ('eventId' in selector) {
    throw new RelationError('事件端点走时间线账本解析，不经要素引用索引定位')
  }

  let entry: ElementReferenceEntry

  if ('sourcePath' in selector) {
    const hit = index.entries.find((candidate) => candidate.sourcePath === selector.sourcePath)
    if (!hit) {
      throw new RelationError(`找不到要素文件 ${selector.sourcePath}；可能已被删除或改名，请重新选择`)
    }
    entry = hit
  } else if ('id' in selector) {
    const resolution = resolveElementById(index, selector.id)
    if (resolution.status === 'missing') {
      throw new RelationError(
        `找不到标识为 ${selector.id} 的要素；要素可能已删除或标识有误。可改用「类型 + 名称」定位，或先用 RelationCheck 检查账本`,
      )
    }
    if (resolution.status === 'ambiguous') {
      throw new RelationError(
        `标识 ${selector.id} 被多个要素占用（${resolution.sourcePaths.join('、')}），无法确定指向；请先在要素库中修正重复标识`,
      )
    }
    entry = resolution.entry
  } else {
    const exact = searchElementEntries(index, selector.name, selector.type).filter((candidate) => candidate.name === selector.name)
    if (exact.length === 0) {
      throw new RelationError(
        `在 ${selector.type} 中找不到名为「${selector.name}」的要素；请核对要素名（区分大小写与全半角），或先创建该要素文件`,
      )
    }
    if (exact.length > 1) {
      throw new RelationError(
        `${selector.type} 中有 ${exact.length} 个名为「${selector.name}」的要素（${exact.map((candidate) => candidate.sourcePath).join('、')}），无法确定指向；请先消除重名`,
      )
    }
    entry = exact[0]
  }

  if (!RELATION_ELEMENT_NODE_TYPES.includes(entry.type)) {
    throw new RelationError(`「${entry.name}」的要素类型（${entry.type}）不能作为关系节点`)
  }
  return entry
}

/** 已定位的端点：要素（引用索引条目）或事件（时间线账本中的事件标题）。 */
export type LocatedEndpoint =
  | { kind: 'element'; entry: ElementReferenceEntry }
  | { kind: 'event'; eventId: string; title: string }

/** 只读定位事件端点：时间线账本中按 EVT- 标识查找事件标题。 */
async function locateEventEndpoint(project: ProjectSnapshot, eventId: string): Promise<LocatedEndpoint> {
  let document
  try {
    document = await loadTimelineLedger(project)
  } catch (error) {
    if (error instanceof TimelineCorruptError) {
      throw new RelationError('时间线账本已损坏，暂时无法解析事件引用；请先在时间轴中初始化修复账本，再登记事件关系')
    }
    throw error
  }
  const marker = document.markers.find(
    (candidate): candidate is Extract<TimelineMarker, { event: TimelineEvent }> => candidate.kind !== 'end' && candidate.eventId === eventId,
  )
  if (!marker) {
    throw new RelationError(
      `找不到事件 ${eventId}；事件可能已被删除。可用 TimelineList 查看现有事件标识，或改用要素端点`,
    )
  }
  return { kind: 'event', eventId, title: marker.event.title }
}

/** 统一入口：按选择器定位端点（要素走引用索引，事件走时间线账本）。 */
async function locateRelationEndpoint(
  project: ProjectSnapshot,
  index: ElementReferenceIndex,
  selector: RelationNodeSelector,
): Promise<LocatedEndpoint> {
  if (selector.kind === 'event') {
    if (!selector.eventId) {
      throw new RelationError('事件端点缺少事件标识；请传入 EVT- 开头的事件标识')
    }
    return locateEventEndpoint(project, selector.eventId)
  }
  return { kind: 'element', entry: locateRelationNode(index, selector) }
}

/** 校验通过后落地端点引用：要素懒分配标识，事件直接成引用。 */
async function finalizeEndpoint(project: ProjectSnapshot, located: LocatedEndpoint): Promise<ResolvedNode> {
  if (located.kind === 'event') {
    return { kind: 'event', ref: { kind: 'event', id: located.eventId }, entry: null, assignedId: false }
  }
  return assignNodeId(project, located.entry)
}

/** 已定位端点的预期引用（要素缺标识时为 null：重复校验推迟到分配后）。 */
function plannedEndpointRef(located: LocatedEndpoint): RelationNodeRef | null {
  if (located.kind === 'event') {
    return { kind: 'event', id: located.eventId }
  }
  return located.entry.id ? { kind: 'element', id: located.entry.id } : null
}

/** 两端是否指向同一对象（自环校验）：要素比路径，事件比标识。 */
function sameEndpointTarget(left: LocatedEndpoint, right: LocatedEndpoint): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'event' && right.kind === 'event') {
    return left.eventId === right.eventId
  }
  if (left.kind === 'element' && right.kind === 'element') {
    return left.entry.sourcePath === right.entry.sourcePath
  }
  return false
}

/** 为已校验的节点确保稳定标识（缺失时写回 frontmatter）。 */
export async function assignNodeId(project: ProjectSnapshot, entry: ElementReferenceEntry): Promise<ResolvedNode> {
  const ensured = await ensureElementId(project, entry.sourcePath)
  return {
    kind: 'element',
    ref: { kind: 'element', id: ensured.id },
    entry: { ...entry, id: ensured.id },
    assignedId: ensured.assigned,
  }
}

/* ---------- 校验原语 ---------- */

function assertDistinctEndpoints(from: RelationNodeRef, to: RelationNodeRef): void {
  if (from.kind === to.kind && from.id === to.id) {
    throw new RelationError('关系的两端不能是同一个对象（自环）；如果只想给单个要素做标注，请写进要素正文')
  }
}

function assertTypeText(type: string): void {
  if (!type) {
    throw new RelationError('关系类型不能为空；用简短短词概括（如 盟友、血缘、隶属、位于）')
  }
  if (type.length > 30) {
    throw new RelationError('关系类型请控制在 30 字以内的短词（详细语义写在 description）')
  }
}

function findDuplicateRelation(
  relations: readonly RelationRecord[],
  from: RelationNodeRef,
  to: RelationNodeRef,
  type: string,
  excludeId?: string,
): RelationRecord | undefined {
  return relations.find(
    (relation) =>
      relation.id !== excludeId
      && relation.type === type
      && sameRef(relation.from, from)
      && sameRef(relation.to, to),
  )
}

function sameRef(left: RelationNodeRef, right: RelationNodeRef): boolean {
  return left.kind === right.kind && left.id === right.id
}

function assertNotDuplicate(relations: readonly RelationRecord[], from: RelationNodeRef, to: RelationNodeRef, type: string, excludeId?: string): void {
  const duplicate = findDuplicateRelation(relations, from, to, type, excludeId)
  if (duplicate) {
    throw new RelationError(
      `已存在同向同类型的关系（${duplicate.id}，${type}）；同一方向同一类型只登记一条，`
      + '不同侧面请换类型词或把细节写进 description。反向关系是独立条目，可另登记',
    )
  }
}

/* ---------- 增删改（全部走写锁） ---------- */

export type CreateRelationOptions = {
  from: RelationNodeSelector
  to: RelationNodeSelector
  type: string
  description?: string
  now?: Date
}

export type CreateRelationResult = {
  relation: RelationRecord
  contentHash: string
  /** 本次懒分配了标识的要素（路径 + 新标识），变更呈现与提示用 */
  assignedElementIds: { sourcePath: string; id: string }[]
  /** 账本文件是否为本次新建（变更账本 created/updated 区分用） */
  created: boolean
}

export async function createRelation(project: ProjectSnapshot, options: CreateRelationOptions): Promise<CreateRelationResult> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    assertWritable(document)

    const type = options.type.trim()
    assertTypeText(type)

    // 先做完全部只读校验，再懒分配标识：失败的登记不得改写任何要素文件
    const { snapshot, index } = await freshReferenceIndex(project)
    const fromLocated = await locateRelationEndpoint(snapshot, index, options.from)
    const toLocated = await locateRelationEndpoint(snapshot, index, options.to)
    if (sameEndpointTarget(fromLocated, toLocated)) {
      assertDistinctEndpoints({ kind: 'element', id: 'self' }, { kind: 'element', id: 'self' })
    }
    const plannedFrom = plannedEndpointRef(fromLocated)
    const plannedTo = plannedEndpointRef(toLocated)
    if (plannedFrom && plannedTo) {
      assertNotDuplicate(document.relations, plannedFrom, plannedTo, type)
    }

    const from = await finalizeEndpoint(snapshot, fromLocated)
    const to = await finalizeEndpoint(snapshot, toLocated)

    const now = (options.now ?? new Date()).toISOString()
    const relation: RelationRecord = {
      id: generateRelationId(),
      from: from.ref,
      to: to.ref,
      type,
      description: options.description?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    }

    document.relations = [...document.relations, relation]
    const contentHash = await persistLedger(project, document)

    const assignedElementIds: { sourcePath: string; id: string }[] = []
    if (from.kind === 'element' && from.assignedId) assignedElementIds.push({ sourcePath: from.entry.sourcePath, id: from.ref.id })
    if (to.kind === 'element' && to.assignedId) assignedElementIds.push({ sourcePath: to.entry.sourcePath, id: to.ref.id })

    return {
      relation,
      contentHash,
      assignedElementIds,
      created: document.contentHash === null,
    }
  })
}

export type UpdateRelationOptions = {
  id: string
  type?: string
  description?: string
  from?: RelationNodeSelector
  to?: RelationNodeSelector
  /** 调用方持有的整本账本基线内容哈希；与磁盘不一致即冲突（任何账本写入都会使其失效） */
  expectedContentHash?: string
  /**
   * 调用方持有的这一条关系的版本（relationVersion）；只有这条关系本身被改过才算冲突。
   * UI 编辑会话用它：别的关系或画布坐标的写入不应让正在编辑的关系误报冲突。
   */
  expectedRelationVersion?: string
  now?: Date
}

/** 单条关系的版本令牌（内容决定，跨读取稳定）。 */
export function relationVersion(relation: RelationRecord): string {
  return hashContent(JSON.stringify([relation.id, relation.from, relation.to, relation.type, relation.description, relation.updatedAt]))
}

export type UpdateRelationResult = {
  relation: RelationRecord
  previous: RelationRecord
  contentHash: string
  assignedElementIds: { sourcePath: string; id: string }[]
}

export async function updateRelation(project: ProjectSnapshot, options: UpdateRelationOptions): Promise<UpdateRelationResult> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    assertWritable(document)

    if (options.expectedContentHash !== undefined && document.contentHash !== options.expectedContentHash) {
      throw new RelationConflictError(document.contentHash)
    }

    const current = document.relations.find((relation) => relation.id === options.id)
    if (!current) {
      if (options.expectedRelationVersion !== undefined) {
        // 编辑会话的这条关系已被删除：按冲突处理（界面走「磁盘版本已不存在」出口）
        throw new RelationConflictError(document.contentHash)
      }
      throw new RelationError(`关系 ${options.id} 不存在；可能已被删除，请用 RelationList 重新查看`)
    }
    if (options.expectedRelationVersion !== undefined && relationVersion(current) !== options.expectedRelationVersion) {
      throw new RelationConflictError(document.contentHash)
    }

    if (
      options.type === undefined
      && options.description === undefined
      && options.from === undefined
      && options.to === undefined
    ) {
      throw new RelationError('至少提供 type、description、from、to 中要修改的一项')
    }

    const type = options.type !== undefined ? options.type.trim() : current.type
    assertTypeText(type)

    // 端点未变（选择器标识即当前引用）不重新解析：悬空/重复标识的关系仍可改类型与描述
    const isUnchanged = (selector: RelationNodeSelector | undefined, ref: RelationNodeRef) =>
      selector === undefined
      || ('id' in selector && ref.kind === 'element' && selector.id === ref.id)
      || (selector.kind === 'event' && ref.kind === 'event' && selector.eventId === ref.id)
    const needsFrom = !isUnchanged(options.from, current.from)
    const needsTo = !isUnchanged(options.to, current.to)

    let fromLocated: LocatedEndpoint | null = null
    let toLocated: LocatedEndpoint | null = null
    let snapshot: ProjectSnapshot = project
    if (needsFrom || needsTo) {
      const fresh = await freshReferenceIndex(project)
      snapshot = fresh.snapshot
      if (needsFrom) fromLocated = await locateRelationEndpoint(snapshot, fresh.index, options.from!)
      if (needsTo) toLocated = await locateRelationEndpoint(snapshot, fresh.index, options.to!)
    }

    // 只读校验（含自环/重复）先于懒分配
    const plannedFrom: RelationNodeRef | null = fromLocated ? plannedEndpointRef(fromLocated) : current.from
    const plannedTo: RelationNodeRef | null = toLocated ? plannedEndpointRef(toLocated) : current.to
    if (fromLocated && toLocated && sameEndpointTarget(fromLocated, toLocated)) {
      assertDistinctEndpoints({ kind: 'element', id: 'self' }, { kind: 'element', id: 'self' })
    }
    if (plannedFrom && plannedTo) {
      assertDistinctEndpoints(plannedFrom, plannedTo)
      assertNotDuplicate(document.relations, plannedFrom, plannedTo, type, options.id)
    }

    const assignedElementIds: { sourcePath: string; id: string }[] = []
    let from = current.from
    let to = current.to
    if (fromLocated) {
      const resolved = await finalizeEndpoint(snapshot, fromLocated)
      from = resolved.ref
      if (resolved.kind === 'element' && resolved.assignedId) {
        assignedElementIds.push({ sourcePath: resolved.entry.sourcePath, id: resolved.ref.id })
      }
    }
    if (toLocated) {
      const resolved = await finalizeEndpoint(snapshot, toLocated)
      to = resolved.ref
      if (resolved.kind === 'element' && resolved.assignedId) {
        assignedElementIds.push({ sourcePath: resolved.entry.sourcePath, id: resolved.ref.id })
      }
    }

    const relation: RelationRecord = {
      ...current,
      from,
      to,
      type,
      description: options.description !== undefined ? options.description.trim() : current.description,
      updatedAt: (options.now ?? new Date()).toISOString(),
    }

    document.relations = document.relations.map((item) => (item.id === options.id ? relation : item))
    const contentHash = await persistLedger(project, document)
    return { relation, previous: current, contentHash, assignedElementIds }
  })
}

export async function deleteRelation(project: ProjectSnapshot, id: string): Promise<{ removed: RelationRecord; contentHash: string }> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    assertWritable(document)

    const removed = document.relations.find((relation) => relation.id === id)
    if (!removed) {
      throw new RelationError(`关系 ${id} 不存在；可能已被删除`)
    }

    document.relations = document.relations.filter((relation) => relation.id !== id)
    const contentHash = await persistLedger(project, document)
    return { removed, contentHash }
  })
}

/* ---------- 坐标保存（重基合并：只替换 layout，冲突自动重试一次） ---------- */

export async function saveRelationLayout(project: ProjectSnapshot, layout: RelationLayoutMap): Promise<{ contentHash: string }> {
  return withRelationWriteLock(project, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const document = await loadRelationLedger(project)
      if (hasStructuralIssue(document)) {
        throw new RelationError('关系账本的 relations 或 layout 整体格式不合法，坐标暂不能保存；请先在关系图谱中清理异常条目')
      }
      document.layout = { ...layout }
      try {
        // 坐标是纯展示状态：隔离的异常条目原样写回，不借坐标保存把手工数据洗掉
        const contentHash = await persistLedger(project, document, { preserveIssues: true })
        return { contentHash }
      } catch (error) {
        if (error instanceof RelationConflictError && attempt === 0) {
          // 外部并发改动：重读最新账本，只重放坐标（关系数据以磁盘为准）
          continue
        }
        throw error
      }
    }
    throw new RelationConflictError(null)
  })
}

/* ---------- 异常清理与悬空级联 ---------- */

/** 清理账本中的隔离条目（用户在关系图谱中明确确认后调用）。 */
export async function removeInvalidRelationEntries(project: ProjectSnapshot): Promise<{ removed: RelationLedgerIssue[]; contentHash: string }> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    if (document.issues.length === 0) {
      return { removed: [], contentHash: document.contentHash ?? '' }
    }
    const removed = document.issues
    document.issues = []
    const contentHash = await persistLedger(project, document)
    return { removed, contentHash }
  })
}

async function removeRelationsToElementIds(project: ProjectSnapshot, elementIds: ReadonlySet<string>): Promise<{ removedRelations: RelationRecord[]; contentHash: string | null }> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    // 级联不受隔离条目阻挡：要素已删除，留着引用只会制造悬空；隔离条目原样写回
    if (hasStructuralIssue(document)) {
      assertWritable(document)
    }

    const removedRelations = document.relations.filter(
      (relation) =>
        (relation.from.kind === 'element' && elementIds.has(relation.from.id))
        || (relation.to.kind === 'element' && elementIds.has(relation.to.id)),
    )
    if (removedRelations.length === 0 && ![...elementIds].some((id) => id in document.layout)) {
      return { removedRelations: [], contentHash: document.contentHash }
    }

    document.relations = document.relations.filter((relation) => !removedRelations.includes(relation))
    for (const id of elementIds) {
      delete document.layout[id]
    }
    const contentHash = await persistLedger(project, document, { preserveIssues: true })
    return { removedRelations, contentHash }
  })
}

/** 级联：按稳定标识移除引用该要素的全部关系（要素删除链路调用）。 */
export async function removeRelationsReferencing(project: ProjectSnapshot, elementId: string): Promise<{ removedRelations: RelationRecord[]; contentHash: string | null }> {
  return removeRelationsToElementIds(project, new Set([elementId]))
}

/** 级联（事件删除链路）：移除任一端引用该事件的全部关系，并清理其画布坐标。 */
export async function removeRelationsReferencingEvent(project: ProjectSnapshot, eventId: string): Promise<{ removedRelations: RelationRecord[]; contentHash: string | null }> {
  return withRelationWriteLock(project, async () => {
    const document = await loadRelationLedger(project)
    // 对齐要素级联：隔离条目不阻挡，原样写回
    if (hasStructuralIssue(document)) {
      assertWritable(document)
    }

    const removedRelations = document.relations.filter(
      (relation) => relation.from.kind === 'event' && relation.from.id === eventId
        || relation.to.kind === 'event' && relation.to.id === eventId,
    )
    if (removedRelations.length === 0 && !(eventId in document.layout)) {
      return { removedRelations: [], contentHash: document.contentHash }
    }

    document.relations = document.relations.filter((relation) => !removedRelations.includes(relation))
    delete document.layout[eventId]
    const contentHash = await persistLedger(project, document, { preserveIssues: true })
    return { removedRelations, contentHash }
  })
}

/** 级联（按路径）：先经引用索引把路径映射为标识，再统一移除（DeleteFile 等只握有路径的链路）。 */
export async function removeRelationsReferencingPath(project: ProjectSnapshot, sourcePath: string): Promise<{ removedRelations: RelationRecord[]; elementIds: string[] }> {
  const { index } = await freshReferenceIndex(project)
  const ids = index.entries.filter((entry) => entry.sourcePath === sourcePath && entry.id).map((entry) => entry.id)
  if (ids.length === 0) {
    return { removedRelations: [], elementIds: [] }
  }
  const { removedRelations } = await removeRelationsToElementIds(project, new Set(ids))
  return { removedRelations, elementIds: ids }
}

/* ---------- 查询与检查（只读，无锁） ---------- */

export type RelationQueryFilter = {
  elementId?: string
  elementIds?: string[]
}

export async function queryRelations(project: ProjectSnapshot, filter: RelationQueryFilter): Promise<RelationLedgerDocument> {
  const document = await loadRelationLedger(project)
  if (filter.elementId !== undefined) {
    document.relations = document.relations.filter(
      (relation) =>
        (relation.from.kind === 'element' && relation.from.id === filter.elementId)
        || (relation.to.kind === 'element' && relation.to.id === filter.elementId),
    )
  } else if (filter.elementIds !== undefined) {
    const idSet = new Set(filter.elementIds)
    document.relations = document.relations.filter(
      (relation) =>
        relation.from.kind === 'element' && idSet.has(relation.from.id)
        && relation.to.kind === 'element' && idSet.has(relation.to.id),
    )
  }
  return document
}

export type RelationCheckIssue =
  | RelationLedgerIssue
  | { kind: 'duplicate-relation'; id: string; duplicateOf: string; fromId: string; toId: string; type: string }
  | { kind: 'dangling-reference'; relationId: string; endpoint: 'from' | 'to'; id: string }
  | { kind: 'ambiguous-reference'; relationId: string; endpoint: 'from' | 'to'; id: string; sourcePaths: string[] }

/** 全量检查：账本隔离条目 + 重复关系 + 悬空/歧义引用（要素与事件端点分别解析）。 */
export async function checkRelationLedger(project: ProjectSnapshot): Promise<{ issues: RelationCheckIssue[] }> {
  const { index } = await freshReferenceIndex(project)
  const document = await loadRelationLedger(project)
  const issues: RelationCheckIssue[] = [...document.issues]

  // 事件端点按时间线账本解析；账本损坏时跳过事件检查（时间线界面自身会呈现损坏态）
  let eventIds: Set<string> | null = null
  try {
    const timeline = await loadTimelineLedger(project)
    eventIds = new Set(timeline.markers.filter((marker) => marker.kind !== 'end').map((marker) => marker.eventId))
  } catch (error) {
    if (!(error instanceof TimelineCorruptError)) {
      throw error
    }
  }

  for (const relation of document.relations) {
    for (const endpoint of ['from', 'to'] as const) {
      const ref = relation[endpoint]
      if (ref.kind === 'event') {
        if (eventIds && !eventIds.has(ref.id)) {
          issues.push({ kind: 'dangling-reference', relationId: relation.id, endpoint, id: ref.id })
        }
        continue
      }
      const resolution = resolveElementById(index, ref.id)
      if (resolution.status === 'missing') {
        issues.push({ kind: 'dangling-reference', relationId: relation.id, endpoint, id: ref.id })
      } else if (resolution.status === 'ambiguous') {
        issues.push({ kind: 'ambiguous-reference', relationId: relation.id, endpoint, id: ref.id, sourcePaths: resolution.sourcePaths })
      }
    }
  }

  // 重复三元组（同向同类型）
  const seen = new Map<string, string>()
  for (const relation of document.relations) {
    const key = `${relation.from.kind}:${relation.from.id} → ${relation.to.kind}:${relation.to.id} [${relation.type}]`
    const existing = seen.get(key)
    if (existing) {
      issues.push({ kind: 'duplicate-relation', id: relation.id, duplicateOf: existing, fromId: relation.from.id, toId: relation.to.id, type: relation.type })
    } else {
      seen.set(key, relation.id)
    }
  }

  return { issues }
}

/* ---------- 标识生成 ---------- */

function generateRelationId(): string {
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
  return `REL-${out}`
}
