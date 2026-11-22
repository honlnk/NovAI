import { sanitizeFileNameFragment } from '../card-board/parser'
import { sortBoardCards } from '../card-board/ordering'
import { FORESHADOWING_DIRECTORY } from '../../types/foreshadowing'
import type { ForeshadowingCard, ForeshadowingCardView } from '../../types/foreshadowing'

/**
 * 伏笔稳定标识与文件名。
 *
 * 标识格式 `F-XXX`（三位补零时序号），文件名「F-XXX-<伏笔名>.md」：标识在创建时
 * 确定且不可改，伏笔名可改（文件名同步）。读取以 frontmatter.id 定位，文件名只用于
 * 外部浏览友好（与计划同一模式）。
 */

/** 时序号 → 稳定标识（F-001 起，三位补零，超出自然扩展位数）。 */
export function createForeshadowingId(sequence: number): string {
  return `F-${String(sequence).padStart(3, '0')}`
}

/** 从文件名提取时序号；提取不出（外部手建文件）返回 null。 */
export function extractForeshadowingSequence(sourcePath: string): number | null {
  const name = sourcePath.split('/').pop() ?? ''
  const match = /^F-(\d+)(?:-|\.)/.exec(name)
  return match ? Number(match[1]) : null
}

/** 组装伏笔文件名：F-XXX-<清理后伏笔名>.md；名清理后为空回退 F-XXX.md。 */
export function createForeshadowingFileName(id: string, name: string): string {
  const safeName = sanitizeFileNameFragment(name)
  return safeName ? `${id}-${safeName}.md` : `${id}.md`
}

/** 组装伏笔项目内相对路径。 */
export function createForeshadowingPath(id: string, name: string): string {
  return `${FORESHADOWING_DIRECTORY}/${createForeshadowingFileName(id, name)}`
}

// 应用标准命名：F-XXX-<名>.md 与 F-XXX.md 两种形态。
const FORESHADOWING_FILE_PATTERN = /^F-\d+(?:-.*)?\.md$/

/** 是否为应用自己命名规则下的伏笔文件（区分外部手建文件）。 */
export function isStandardForeshadowingFileName(sourcePath: string): boolean {
  const name = sourcePath.split('/').pop() ?? ''
  return FORESHADOWING_FILE_PATTERN.test(name)
}

/** 伏笔目录直接子级的 .md 文件才是一条伏笔；子目录与其他后缀一律不收。 */
export function isForeshadowingCardPath(path: string): boolean {
  return path.startsWith(`${FORESHADOWING_DIRECTORY}/`) && path.endsWith('.md') && path.split('/').length === 2
}

/** 同列排序（通用排序原语的领域包装，保持单一事实来源）。 */
export function sortForeshadowingCards<T extends Pick<ForeshadowingCard, 'order' | 'createdAt' | 'id'>>(cards: readonly T[]): T[] {
  return sortBoardCards(cards)
}

export type ForeshadowingCardWithView = ForeshadowingCardView
