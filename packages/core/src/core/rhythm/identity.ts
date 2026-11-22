import { sanitizeFileNameFragment } from '../card-board/parser'
import { sortBoardCards } from '../card-board/ordering'
import { RHYTHM_DIRECTORY } from '../../types/rhythm'
import type { RhythmCard, RhythmCardView } from '../../types/rhythm'

/**
 * 节奏卡稳定标识与文件名。
 *
 * 标识格式 `R-XXX`（三位补零时序号），文件名「R-XXX-<节奏卡名>.md」：标识在创建时
 * 确定且不可改，节奏卡名可改（文件名同步）。读取以 frontmatter.id 定位，文件名只
 * 用于外部浏览友好（与伏笔同一模式）。
 */

/** 时序号 → 稳定标识（R-001 起，三位补零，超出自然扩展位数）。 */
export function createRhythmId(sequence: number): string {
  return `R-${String(sequence).padStart(3, '0')}`
}

/** 从文件名提取时序号；提取不出（外部手建文件）返回 null。 */
export function extractRhythmSequence(sourcePath: string): number | null {
  const name = sourcePath.split('/').pop() ?? ''
  const match = /^R-(\d+)(?:-|\.)/.exec(name)
  return match ? Number(match[1]) : null
}

/** 组装节奏卡文件名：R-XXX-<清理后卡名>.md；名清理后为空回退 R-XXX.md。 */
export function createRhythmFileName(id: string, name: string): string {
  const safeName = sanitizeFileNameFragment(name)
  return safeName ? `${id}-${safeName}.md` : `${id}.md`
}

/** 组装节奏卡项目内相对路径。 */
export function createRhythmPath(id: string, name: string): string {
  return `${RHYTHM_DIRECTORY}/${createRhythmFileName(id, name)}`
}

// 应用标准命名：R-XXX-<名>.md 与 R-XXX.md 两种形态。
const RHYTHM_FILE_PATTERN = /^R-\d+(?:-.*)?\.md$/

/** 是否为应用自己命名规则下的节奏卡文件（区分外部手建文件）。 */
export function isStandardRhythmFileName(sourcePath: string): boolean {
  const name = sourcePath.split('/').pop() ?? ''
  return RHYTHM_FILE_PATTERN.test(name)
}

/** 节奏卡目录直接子级的 .md 文件才是一张节奏卡；子目录与其他后缀一律不收。 */
export function isRhythmCardPath(path: string): boolean {
  return path.startsWith(`${RHYTHM_DIRECTORY}/`) && path.endsWith('.md') && path.split('/').length === 2
}

/** 同列排序（通用排序原语的领域包装，保持单一事实来源）。 */
export function sortRhythmCards<T extends Pick<RhythmCard, 'order' | 'createdAt' | 'id'>>(cards: readonly T[]): T[] {
  return sortBoardCards(cards)
}

export type RhythmCardWithView = RhythmCardView
