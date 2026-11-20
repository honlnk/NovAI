import type { ElementType } from './rag'

/**
 * 关系账本领域类型（关系图谱施工计划 §二）。
 *
 * 关系是项目级关系账本：`elements/relations.json` 单文件保存全部关系与画布坐标，
 * 有向（from → to）、多重（同对节点允许多种关系并存）、type 为开放短词。
 * 节点引用统一 `{ kind, id }` 对象，`event` 为时间线事件账本预留（第一版只接受 element）。
 */

export const RELATION_LEDGER_PATH = 'elements/relations.json'

export const RELATION_LEDGER_VERSION = 1

export type RelationNodeKind = 'element' | 'event'

export type RelationNodeRef = {
  kind: RelationNodeKind
  id: string
}

export type RelationRecord = {
  /** REL- + 10 位，域内生成、创建后不变 */
  id: string
  from: RelationNodeRef
  to: RelationNodeRef
  /** 开放短词（如 盟友/血缘/隶属），用于筛选与确定性查询 */
  type: string
  /** 自然语言描述；空串 = 未登记（不强迫每条关系写散文） */
  description: string
  createdAt: string
  updatedAt: string
}

/** 画布坐标（节点 id → 视口位置）；纯展示状态，不参与语义判断。 */
export type RelationLayoutMap = Record<string, { x: number; y: number }>

export type RelationLedger = {
  version: typeof RELATION_LEDGER_VERSION
  relations: RelationRecord[]
  layout: RelationLayoutMap
}

/** 可以作为关系节点的要素类型：五类要素；旧时间线要素不是关系节点（事件账本完成后改引用事件）。 */
export const RELATION_ELEMENT_NODE_TYPES: readonly ElementType[] = [
  'character',
  'location',
  'entity',
  'plot',
  'worldbuilding',
]

/** 账本加载时隔离出的单条非法数据（保留原始内容呈现，写入被阻止直至清理）。 */
export type RelationLedgerIssue =
  | { kind: 'invalid-relation'; index: number; reason: string; raw: unknown }
  | { kind: 'invalid-layout-entry'; key: string; reason: string; raw: unknown }

/** 加载后的账本文档：合法数据 + 隔离 issue + 基线内容哈希（null = 文件尚不存在）。 */
export type RelationLedgerDocument = {
  relations: RelationRecord[]
  layout: RelationLayoutMap
  issues: RelationLedgerIssue[]
  contentHash: string | null
}

export const RELATION_ID_PATTERN = /^REL-[0-9a-z]{10}$/
