/**
 * 伏笔领域类型（UI 无关，《创作心智模块施工计划》§三）。
 *
 * 一条伏笔 = 项目根目录 foreshadowing/ 直接子级的一个 Markdown 文件：
 * 领域字段放 frontmatter（埋设章节、回收窗口、关联角色等），正文固定分两节——
 * 「读者视角」（当时可见事实）与「作者真相」（剧透），两节必须分开记。
 *
 * 伏笔目录只对主智能体开放（要素管理员不可见，见 element-manager 的目录守卫）：
 * 设定账本管「是什么」，伏笔账本管「欠了什么」，两本账不能混。
 */

import { CardBoardCard, CardBoardError } from './card-board'

/** 伏笔目录名（项目根目录下）。 */
export const FORESHADOWING_DIRECTORY = 'foreshadowing'

/**
 * 伏笔六状态（frontmatter 精确值）：
 * planted=埋入 / hinted=暗示 / developed=发展 / revealed=揭晓 / resolved=解决 / abandoned=放弃。
 */
export type ForeshadowingStatus =
  | 'planted'
  | 'hinted'
  | 'developed'
  | 'revealed'
  | 'resolved'
  | 'abandoned'

/** 全部合法状态；顺序即精确值的自然推进序。 */
export const FORESHADOWING_STATUSES: readonly ForeshadowingStatus[] = [
  'planted',
  'hinted',
  'developed',
  'revealed',
  'resolved',
  'abandoned',
]

export function isForeshadowingStatus(value: string): value is ForeshadowingStatus {
  return (FORESHADOWING_STATUSES as readonly string[]).includes(value)
}

/**
 * 看板列（默认四列视图）：已埋 / 推进中 / 已收 / 已放弃。
 * 六状态折叠映射：hinted+developed → 推进中；revealed+resolved → 已收。
 * 项目设置可选 4/6 列模式（见 novel.config 的 foreshadowing.statusMode）。
 */
export const FORESHADOWING_COLUMNS: readonly ForeshadowingColumn[] = ['planted', 'advancing', 'paid', 'abandoned']

export type ForeshadowingColumn = 'planted' | 'advancing' | 'paid' | 'abandoned'

/** 六状态 → 看板列（四列模式）的折叠映射。 */
export const FORESHADOWING_COLUMN_BY_STATUS: Record<ForeshadowingStatus, ForeshadowingColumn> = {
  planted: 'planted',
  hinted: 'advancing',
  developed: 'advancing',
  revealed: 'paid',
  resolved: 'paid',
  abandoned: 'abandoned',
}

/** 看板列展示名（列头/筛选用）。 */
export const FORESHADOWING_COLUMN_LABELS: Record<ForeshadowingColumn, string> = {
  planted: '已埋',
  advancing: '推进中',
  paid: '已收',
  abandoned: '已放弃',
}

/** 状态展示名（六状态精确值）。 */
export const FORESHADOWING_STATUS_LABELS: Record<ForeshadowingStatus, string> = {
  planted: '埋入',
  hinted: '暗示',
  developed: '发展',
  revealed: '揭晓',
  resolved: '解决',
  abandoned: '放弃',
}

/** 伏笔卡片 = 通用看板卡片骨架 + 伏笔领域字段。 */
export type ForeshadowingCard = CardBoardCard<ForeshadowingStatus> & {
  /** 伏笔名（作者可改；名称变化时文件名同步）。 */
  name: string
  /** 埋设章节（完整路径「卷/章」，如 第一卷/第012章）。 */
  plantedAt: string
  /** 预计回收窗口（区间两端；连载节奏会调整，建议给区间而非单点）。 */
  payoffWindow: readonly [string, string] | null
  /** 关联角色。 */
  relatedCharacters: readonly string[]
  /** 关联物品/实体。 */
  relatedEntities: readonly string[]
  /** 暗示历史：每次再提及的章节列表（自动累积）。 */
  relatedChapters: readonly string[]
  /** 是否故意误导（红鲱鱼）。 */
  isRedHerring: boolean
  /** 实际回收章节；未回收为 null。 */
  resolvedAt: string | null
  /** 放弃原因（避免日后误以为漏写）；未放弃为 null。 */
  abandonedReason: string | null
}

export type ForeshadowingCardView = ForeshadowingCard & {
  /** 摘要（读者视角正文首行，不含作者真相）。 */
  summary: string
  /** 读者视角正文（正文去掉「作者真相」节；写正文链路唯一可见的正文形态）。 */
  readerBody: string
}

/** 目录扫描结果（与计划同款骨架，卡片类型具体化）。 */
export type ForeshadowingScanResult = {
  cards: ForeshadowingCardView[]
  issues: ForeshadowingScanIssue[]
}

export type ForeshadowingScanIssue =
  | { kind: 'duplicate-id'; id: string; paths: string[] }
  | { kind: 'unreadable-file'; path: string; reason: string }

/** 伏笔领域操作失败。 */
export class ForeshadowingError extends CardBoardError {
  constructor(message: string) {
    super(message)
    this.name = 'ForeshadowingError'
  }
}

/** 正文/字段更新冲突：文件当前内容与调用方持有的版本不一致（外部或用户已修改）。 */
export class ForeshadowingConflictError extends ForeshadowingError {
  /** 冲突文件的当前内容，供界面提示「重新读取」使用。 */
  readonly currentCard: ForeshadowingCard

  constructor(message: string, currentCard: ForeshadowingCard) {
    super(message)
    this.name = 'ForeshadowingConflictError'
    this.currentCard = currentCard
  }
}
