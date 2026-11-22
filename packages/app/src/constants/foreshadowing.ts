import {
  FORESHADOWING_COLUMN_BY_STATUS,
  FORESHADOWING_COLUMN_LABELS,
  FORESHADOWING_COLUMNS,
  FORESHADOWING_STATUSES,
  FORESHADOWING_STATUS_LABELS,
  type ForeshadowingColumn,
  type ForeshadowingStatus,
} from '@novai/core/types/foreshadowing'
import type { ForeshadowingCardSummaryView } from '@novai/core/services/types'

/**
 * 伏笔看板的展示口径（创作心智模块施工计划 §三/§七）：frontmatter 恒存 6 状态，
 * UI 列数可配——默认 4 列（状态按 COLUMN_BY_STATUS 分组归列），完整模式 6 列
 * （每状态一列）。列模式来自项目设置 foreshadowingStatusMode。
 */

export type ForeshadowingColumnMode = 'default' | 'full'

/** 状态短标签（侧栏行尾徽标用，两处共享：伏笔分类列表与章节侧栏「本章相关伏笔」） */
export const FORESHADOWING_STATUS_SHORT_LABELS: Record<ForeshadowingStatus, string> = {
  planted: '已埋',
  hinted: '暗示',
  developed: '发展',
  revealed: '揭晓',
  resolved: '解决',
  abandoned: '放弃',
}

/** 默认 4 列的跨列拖拽入口状态：拖进该列时的目标状态（列内重排保持原状态） */
export const FORESHADOWING_COLUMN_ENTRY_STATUS: Record<ForeshadowingColumn, ForeshadowingStatus> = {
  planted: 'planted',
  advancing: 'hinted',
  paid: 'revealed',
  abandoned: 'abandoned',
}

/** 展示列：顺序即展示顺序；key 在默认模式为分组列、完整模式为状态本身 */
export type ForeshadowingDisplayColumn = {
  key: string
  label: string
  cards: ForeshadowingCardSummaryView[]
}

/** 按列模式把 6 状态看板折叠为展示列（默认分组 4 列 / 完整模式 6 列） */
export function foreshadowingDisplayColumns(
  board: { columns: Record<ForeshadowingStatus, readonly ForeshadowingCardSummaryView[]> } | null,
  mode: ForeshadowingColumnMode,
): ForeshadowingDisplayColumn[] {
  if (!board) {
    return []
  }

  if (mode === 'full') {
    return FORESHADOWING_STATUSES.map((status) => ({
      key: status,
      label: FORESHADOWING_STATUS_LABELS[status],
      cards: [...board.columns[status]],
    }))
  }

  return FORESHADOWING_COLUMNS.map((column) => ({
    key: column,
    label: FORESHADOWING_COLUMN_LABELS[column],
    cards: FORESHADOWING_STATUSES
      .filter((status) => FORESHADOWING_COLUMN_BY_STATUS[status] === column)
      .flatMap((status) => [...board.columns[status]]),
  }))
}

/**
 * 看板拖拽落点（列 key）→ 目标状态：完整模式列即状态；默认模式同列重排保持
 * 原状态（推进中列里 hinted/developed 不因重排互相改写），跨列取入口状态。
 */
export function resolveForeshadowingMoveStatus(
  board: { columns: Record<ForeshadowingStatus, readonly ForeshadowingCardSummaryView[]> } | null,
  cardId: string,
  columnKey: string,
  mode: ForeshadowingColumnMode,
): ForeshadowingStatus | null {
  if (mode === 'full') {
    return FORESHADOWING_STATUSES.includes(columnKey as ForeshadowingStatus)
      ? (columnKey as ForeshadowingStatus)
      : null
  }

  const currentStatus = board
    ? (FORESHADOWING_STATUSES.find((status) => board.columns[status].some((card) => card.id === cardId)) ?? null)
    : null
  if (currentStatus && FORESHADOWING_COLUMN_BY_STATUS[currentStatus] === columnKey) {
    // 同列重排：保持原状态（改 order 不改 status）
    return currentStatus
  }
  const column = FORESHADOWING_COLUMNS.find((key) => key === columnKey)
  return column ? FORESHADOWING_COLUMN_ENTRY_STATUS[column] : null
}

/* ---------- 「该收了」高亮（§七：payoff_window 包含当前最新章号） ---------- */

/** 从章节引用（如「第二卷/第080章」或文件名）解析章号；无法解析返回 null */
export function foreshadowingChapterNumber(ref: string): number | null {
  const match = /第(\d+)章/.exec(ref)
  return match ? Number(match[1]) : null
}

/**
 * 是否已进入回收窗口：最新章号 ≥ 窗口起点的章号，且状态尚未揭晓/解决/放弃。
 * 简化按章号数值比较（全本连续编号是主流）；卷内独立编号的作品可能漏报/误报。
 */
export function isForeshadowingDue(
  card: { status: ForeshadowingStatus; payoffWindow: readonly [string, string] | null },
  latestChapterNumber: number | null,
): boolean {
  if (latestChapterNumber === null || !card.payoffWindow) {
    return false
  }
  if (card.status === 'revealed' || card.status === 'resolved' || card.status === 'abandoned') {
    return false
  }
  const start = foreshadowingChapterNumber(card.payoffWindow[0])
  return start !== null && latestChapterNumber >= start
}

/* ---------- 章节侧栏「本章相关伏笔」实时反查（§七/§九：不写入章节文件） ---------- */

/**
 * 章节文件路径（如 chapters/第一卷/第012章-夜行.txt）→ 伏笔引用形态（第一卷/第012章-夜行）。
 * 伏笔 frontmatter 的 plantedAt/relatedChapters 存「卷/章」引用，与路径去掉
 * chapters/ 前缀和扩展名后比对。
 */
export function chapterPathToForeshadowingRef(path: string): string {
  return path.replace(/^chapters\//, '').replace(/\.[^.]+$/, '')
}

/** 本章相关伏笔：埋设章是本章，或暗示历史包含本章（实时计算，不改任何文件） */
export function chapterRelatedForeshadowing(
  cards: readonly ForeshadowingCardSummaryView[],
  chapterPath: string | null | undefined,
): ForeshadowingCardSummaryView[] {
  if (!chapterPath) {
    return []
  }
  const ref = chapterPathToForeshadowingRef(chapterPath)
  return cards.filter((card) => card.plantedAt === ref || card.relatedChapters.includes(ref))
}
