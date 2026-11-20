import {
  RelationConflictError,
  RelationCorruptError,
  checkRelationLedger,
  createRelation,
  deleteRelation,
  loadRelationLedger,
  queryRelations,
  removeInvalidRelationEntries,
  removeRelationsReferencing,
  removeRelationsReferencingPath,
  saveRelationLayout,
  updateRelation,
} from '../core/relation/store'
import {
  buildElementReferenceIndex,
  resolveElementById,
  searchElementEntries,
} from '../core/elements/reference-index'
import { rescanProject, writeProjectTextFile } from '../core/fs/project-fs'
import { createTrashPath } from '../core/fs/trash'
import { writeJsonLedger } from '../core/ledger/json-ledger'
import type { ElementReferenceIndex } from '../core/elements/reference-index'

import { requireRuntimeProject } from './project-runtime'
import type { ProjectSnapshot } from '../types/project'
import type { ElementType } from '../types/rag'
import type {
  RelationLayoutMap,
  RelationLedgerIssue,
  RelationNodeRef,
  RelationRecord,
} from '../types/relation'
import { RELATION_LEDGER_PATH, RELATION_LEDGER_VERSION } from '../types/relation'
import type {
  RelationCheckIssue,
  RelationNodeSelector,
  UpdateRelationOptions,
} from '../core/relation/store'

/**
 * 关系图谱服务层：UI 与专用工具共用的唯一入口（校验、写锁与冲突规则只有一个事实来源）。
 *
 * - 视图（graph / elementOptions）把节点引用解析为「已解析 / 缺失 / 歧义」三态，
 *   画布幽灵节点与检查报告共用同一解析结果。
 * - 所有写入成功后广播 RelationChangeEvent，画布据此刷新（带来源标记，
 *   调用方用它跳过自身写入触发的自刷新）。
 */

/* ---------- 变更通知（模块级监听器，对齐 rag-service 模式） ---------- */

export type RelationChangeEvent = {
  projectId: string
  /** 写入来源：ui = 关系图谱弹窗，agent = 专用工具 */
  source: 'ui' | 'agent'
  kind: 'relations' | 'layout' | 'cleanup' | 'reinitialize'
}

const relationListeners = new Set<(event: RelationChangeEvent) => void>()

export function subscribeRelationChange(listener: (event: RelationChangeEvent) => void): () => void {
  relationListeners.add(listener)
  return () => {
    relationListeners.delete(listener)
  }
}

function broadcastRelationChange(event: RelationChangeEvent): void {
  for (const listener of [...relationListeners]) {
    try {
      listener(event)
    } catch {
      // 监听器异常不阻断广播
    }
  }
}

/* ---------- 视图类型 ---------- */

export type RelationNodeView =
  | { status: 'resolved'; kind: 'element'; id: string; type: ElementType; name: string; summary: string; sourcePath: string }
  | { status: 'missing'; kind: RelationNodeRef['kind']; id: string }
  | { status: 'ambiguous'; kind: 'element'; id: string; sourcePaths: string[] }

export type RelationEdgeView = {
  relation: RelationRecord
  from: RelationNodeView
  to: RelationNodeView
}

export type RelationGraphView = {
  status: 'ok' | 'corrupt'
  /** 账本基线内容哈希（编辑会话版本校验用）；文件不存在为 null */
  contentHash: string | null
  edges: RelationEdgeView[]
  layout: RelationLayoutMap
  issues: RelationLedgerIssue[]
  /** 损坏时的原始内容（只读呈现用） */
  raw?: string
}

/** 关系节点选择器的候选项（搜索添加节点用）：引用索引条目的直接映射。 */
export type RelationElementOptionView = {
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

/* ---------- 读取 ---------- */

export async function getGraph(projectId: string): Promise<RelationGraphView> {
  const project = requireRuntimeProject(projectId)

  let document
  try {
    document = await loadRelationLedger(project)
  } catch (error) {
    if (error instanceof RelationCorruptError) {
      return {
        status: 'corrupt',
        contentHash: null,
        edges: [],
        layout: {},
        issues: [],
        raw: error.raw,
      }
    }
    throw error
  }

  const index = await buildElementReferenceIndex({ ...project, tree: await rescanProject(project) })
  const edges = document.relations.map((relation) => ({
    relation,
    from: resolveNodeView(index, relation.from),
    to: resolveNodeView(index, relation.to),
  }))

  return {
    status: 'ok',
    contentHash: document.contentHash,
    edges,
    layout: document.layout,
    issues: document.issues,
  }
}

function resolveNodeView(
  index: ElementReferenceIndex,
  ref: RelationNodeRef,
): RelationNodeView {
  if (ref.kind === 'event') {
    return { status: 'missing', kind: 'event', id: ref.id }
  }
  const resolution = resolveElementById(index, ref.id)
  if (resolution.status === 'resolved') {
    const entry = resolution.entry
    return {
      status: 'resolved',
      kind: 'element',
      id: entry.id,
      type: entry.type,
      name: entry.name,
      summary: entry.summary,
      sourcePath: entry.sourcePath,
    }
  }
  if (resolution.status === 'ambiguous') {
    return { status: 'ambiguous', kind: 'element', id: ref.id, sourcePaths: resolution.sourcePaths }
  }
  return { status: 'missing', kind: 'element', id: ref.id }
}

/** 按名称子串搜索可作为关系节点的要素（选择器数据；旧时间线要素不出现）。 */
export async function getElementOptions(
  projectId: string,
  query: string,
  type?: ElementType,
): Promise<RelationElementOptionView[]> {
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

/** 账本全量检查（画布检查入口与 RelationCheck 工具共用领域实现）。 */
export async function checkLedger(projectId: string): Promise<{ issues: RelationCheckIssue[] }> {
  const snapshot = await freshSnapshot(projectId)
  return checkRelationLedger(snapshot)
}

/* ---------- 写入（成功后广播变更） ---------- */

export async function createRelationEntry(
  projectId: string,
  options: { from: RelationNodeSelector; to: RelationNodeSelector; type: string; description?: string },
  source: 'ui' | 'agent' = 'ui',
) {
  const project = requireRuntimeProject(projectId)
  const result = await createRelation(project, options)
  broadcastRelationChange({ projectId, source, kind: 'relations' })
  return result
}

export async function updateRelationEntry(projectId: string, options: UpdateRelationOptions, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)
  const result = await updateRelation(project, options)
  broadcastRelationChange({ projectId, source, kind: 'relations' })
  return result
}

export async function deleteRelationEntry(projectId: string, id: string, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)
  const result = await deleteRelation(project, id)
  broadcastRelationChange({ projectId, source, kind: 'relations' })
  return result
}

export async function saveLayout(projectId: string, layout: RelationLayoutMap, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)
  const result = await saveRelationLayout(project, layout)
  broadcastRelationChange({ projectId, source, kind: 'layout' })
  return result
}

export async function cleanupInvalidEntries(projectId: string, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)
  const result = await removeInvalidRelationEntries(project)
  broadcastRelationChange({ projectId, source, kind: 'cleanup' })
  return result
}

/** 级联清理（要素删除链路）：按路径或标识移除引用关系。 */
export async function removeReferences(
  projectId: string,
  target: { sourcePath: string } | { elementId: string },
  source: 'ui' | 'agent' = 'agent',
) {
  const project = requireRuntimeProject(projectId)
  const result = 'sourcePath' in target
    ? await removeRelationsReferencingPath(project, target.sourcePath)
    : await removeRelationsReferencing(project, target.elementId)
  if (result.removedRelations.length > 0) {
    broadcastRelationChange({ projectId, source, kind: 'relations' })
  }
  return result
}

/**
 * 损坏重置（用户在关系图谱中明确确认后调用）：原文件副本先入回收站，再写空账本。
 * 账本当前不处于损坏态时拒绝执行（防误触覆盖有效数据）。
 */
export async function reinitializeLedger(projectId: string, source: 'ui' | 'agent' = 'ui') {
  const project = requireRuntimeProject(projectId)

  let corrupt: RelationCorruptError | null = null
  try {
    await loadRelationLedger(project)
  } catch (error) {
    if (error instanceof RelationCorruptError) {
      corrupt = error
    } else {
      throw error
    }
  }
  if (!corrupt) {
    throw new Error('关系账本当前可以正常读取，无需重新初始化；如需清空请逐条删除关系')
  }

  const trashPath = createTrashPath(RELATION_LEDGER_PATH)
  await writeProjectTextFile(project.handle, trashPath, corrupt.raw)
  await writeJsonLedger({
    project,
    path: RELATION_LEDGER_PATH,
    ledger: null,
    expectedContentHash: 'force',
    serialize: () => JSON.stringify({ version: RELATION_LEDGER_VERSION, relations: [], layout: {} }, null, 2),
  })
  broadcastRelationChange({ projectId, source, kind: 'reinitialize' })
  return { trashPath }
}

/** 冲突错误类型再导出：UI 捕获后映射到保存会话冲突态。 */
export { RelationConflictError, RelationCorruptError }

/** 只读查询透传（RelationQuery 工具与画布聚焦共用）。 */
export { queryRelations }
