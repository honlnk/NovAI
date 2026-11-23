import {
  RHYTHM_COLUMNS,
  RHYTHM_COLUMN_LABELS,
  type RhythmColumn,
  type RhythmStatus,
} from '@novai/core/types/rhythm'
import type { RhythmCardSummaryView } from '@novai/core/services/types'

/**
 * 节奏看板的展示口径：固定三列（规划中 / 已写 / 偏差），状态即列——与伏笔
 * 不同，没有折叠模式。三列之间的流转由偏差判定驱动；跨列拖拽不放行静默无效，
 * 而是进入作者校正操作态（作者字段控制权计划阶段 5 §六）：松手打开详情、
 * 目标状态已选、落点暂存，「应用校正」一次保存判定与目标落点后才移动看板。
 */

export type RhythmDisplayColumn = {
  key: RhythmColumn
  label: string
  cards: RhythmCardSummaryView[]
}

/** 三列展示（顺序即展示顺序；key 即状态） */
export function rhythmDisplayColumns(
  board: { columns: Record<RhythmStatus, readonly RhythmCardSummaryView[]> } | null,
): RhythmDisplayColumn[] {
  if (!board) {
    return []
  }
  return RHYTHM_COLUMNS.map((column) => ({
    key: column,
    label: RHYTHM_COLUMN_LABELS[column],
    cards: [...board.columns[column]],
  }))
}

/**
 * 看板拖拽落点是否放行（阶段 5 §六）：三列都显示合法落点——同列松手即时重排，
 * 跨列松手打开该卡详情的作者校正操作态（目标状态已选、落点暂存待确认），
 * 应用前真实看板保持原位。列 key 非法才不放行。
 */
export function isRhythmDropAllowed(
  board: { columns: Record<RhythmStatus, readonly RhythmCardSummaryView[]> } | null,
  _cardId: string,
  columnKey: string,
): boolean {
  return Boolean(board) && RHYTHM_COLUMNS.includes(columnKey as RhythmColumn)
}

/**
 * 是否同列重排（即时生效路径）：落点列 = 卡片当前列。跨列走作者校正操作态，
 * 由 RhythmBoardPanel 分流上抛，不直接改状态。
 */
export function isRhythmReorderOnly(
  board: { columns: Record<RhythmStatus, readonly RhythmCardSummaryView[]> } | null,
  cardId: string,
  columnKey: string,
): boolean {
  if (!board || !RHYTHM_COLUMNS.includes(columnKey as RhythmColumn)) {
    return false
  }
  return board.columns[columnKey as RhythmStatus].some((card) => card.id === cardId)
}

/** 冲突强度档位着色（§七：1~3 绿 / 4~6 黄 / 7~10 红） */
export function conflictIntensityClass(value: number): string {
  if (value >= 7) {
    return 'bg-red-100 text-red-700'
  }
  if (value >= 4) {
    return 'bg-amber-100 text-amber-700'
  }
  return 'bg-emerald-100 text-emerald-700'
}

/* ---------- 章节侧栏「本章节奏卡」实时反查（§七/§九：不写入章节文件） ---------- */

/**
 * 从章节引用或文件路径解析章号（如「第二卷/第083章」「chapters/第二卷/第083章-夜行.txt」
 * → 83）；无法解析返回 null。与伏笔反查同一「第N章」数值口径（全本连续编号假设）。
 */
export function rhythmChapterNumber(ref: string): number | null {
  const match = /第(\d+)章/.exec(ref)
  return match ? Number(match[1]) : null
}

/** 本章节奏卡：chapterRef 章号 == 本章章号（一章一卡，实时计算，不改任何文件） */
export function chapterRhythmCard(
  cards: readonly RhythmCardSummaryView[],
  chapterPath: string | null | undefined,
): RhythmCardSummaryView | null {
  if (!chapterPath) {
    return null
  }
  const chapter = rhythmChapterNumber(chapterPath)
  if (chapter === null) {
    return null
  }
  return cards.find((card) => rhythmChapterNumber(card.chapterRef) === chapter) ?? null
}
