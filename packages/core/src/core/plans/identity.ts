import { hashContent } from '../util/hash'
import { sanitizeFileNameFragment } from '../card-board/parser'
import {
  nextOrderInColumn as genericNextOrderInColumn,
  orderAfter as genericOrderAfter,
  orderBefore as genericOrderBefore,
  sortBoardCards,
} from '../card-board/ordering'
import { PLANS_DIRECTORY } from '../../types/plans'
import type { PlanCard, PlanCardView } from '../../types/plans'

/**
 * 稳定标识与文件名。
 *
 * 文件名「计划-<创建时序号>-<稳定短标识>.md」在创建时确定，后续修改正文不重命名。
 * 稳定标识 = 时间戳 + 随机串 + 内容 hash 片段，独立于文件名存在（文件改名不影响定位，
 * 因为读取时以 frontmatter.id 为准；文件名只用于外部浏览友好）。
 * 排序/列内取值原语来自 card-board/ordering（通用底层，计划/伏笔/节奏卡共用）。
 */

/** 生成新的稳定标识（plan-<毫秒时间戳>-<随机串>）。 */
export function createPlanId(now = new Date()): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `plan-${now.getTime()}-${random}`
}

/** 由正文内容生成的短标识片段（内容变化时创建阶段的标识不变：只在创建时取一次）。 */
export function createPlanSlug(content: string): string {
  return hashContent(content).slice(1, 9)
}

/** 组装卡片文件名：创建时采用可读名称 计划-<序号>-<清理后计划名>-<短标识>.md。 */
export function createPlanFileName(sequence: number, content: string): string {
  const slug = createPlanSlug(content)
  const title = deriveTitleFromContent(content)
  return createTitledPlanFileName(sequence, title, slug)
}

/** 组装卡片项目内相对路径。 */
export function createPlanPath(sequence: number, content: string): string {
  return `${PLANS_DIRECTORY}/${createPlanFileName(sequence, content)}`
}

/**
 * 从待写入正文中提取可读计划名：取首个非空行，去掉 Markdown 标题标记
 * （与展示标题同规则，创建时把计划名同步进文件名）。
 */
function deriveTitleFromContent(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

  return firstLine.replace(/^#{1,6}\s*/, '')
}

/**
 * 计划名清理为文件名安全片段（通用清理原语见 card-board/parser）。
 */
export function sanitizePlanTitleForFileName(title: string): string | null {
  return sanitizeFileNameFragment(title)
}

/**
 * 组装带计划名的文件名：计划-<序号>-<清理后计划名>-<短标识>.md。
 * 计划名清理后为空时回退到纯短标识形态（旧格式），保证总有合法文件名。
 */
export function createTitledPlanFileName(sequence: number | null, title: string, slug: string): string {
  const safeTitle = sanitizePlanTitleForFileName(title)
  const prefix = sequence === null ? '计划' : `计划-${sequence}`
  return safeTitle ? `${prefix}-${safeTitle}-${slug}.md` : `${prefix}-${slug}.md`
}

/** 从文件名提取创建时序号；提取不出（外部手建文件）返回 null。 */
export function extractPlanSequence(sourcePath: string): number | null {
  const name = sourcePath.split('/').pop() ?? ''
  const match = /^计划-(\d+)-/.exec(name)
  return match ? Number(match[1]) : null
}

/** 从文件名提取创建时的内容短标识（兼容带中文计划名的新格式）；提取不出返回 null。 */
export function extractPlanSlug(sourcePath: string): string | null {
  const name = sourcePath.split('/').pop() ?? ''
  // 形态1（旧）：计划-<序号>-<短标识>.md；形态2（新）：计划-<序号>-<计划名>-<短标识>.md。
  // 短标识取末段 [0-9a-z]+（(?:.*-)? 惰性回溯到最后一个连字符之后）。
  const match = /^计划-(?:\d+-)?(?:.*-)?([0-9a-z]+)\.md$/.exec(name)
  return match ? match[1] : null
}

// 旧格式（计划-<序号>-<短标识>.md）与新格式（计划-<序号>-<计划名>-<短标识>.md）都算应用标准命名。
const PLAN_FILE_PATTERN = /^计划-(?:\d+-)?(?:.*-)?[0-9a-z]+\.md$/

/** 是否为应用自己命名规则下的计划文件（用于区分外部手建文件与标准文件）。 */
export function isStandardPlanFileName(sourcePath: string): boolean {
  const name = sourcePath.split('/').pop() ?? ''
  return PLAN_FILE_PATTERN.test(name)
}

/** 计划目录直接子级的 .md 文件才是一张卡片；子目录与其他后缀一律不收。 */
export function isPlanCardPath(path: string): boolean {
  return path.startsWith(`${PLANS_DIRECTORY}/`) && path.endsWith('.md') && path.split('/').length === 2
}

/**
 * 同列排序：order 升序；order 相同再按 createdAt、id 排序，保证结果确定。
 */
export function sortPlanCards<T extends Pick<PlanCard, 'order' | 'createdAt' | 'id'>>(cards: readonly T[]): T[] {
  return sortBoardCards(cards)
}

/** 目标列末尾的新 order 值：比该列当前最大 order 大一个步长。 */
export function nextOrderInColumn(cards: readonly Pick<PlanCard, 'status' | 'order'>[], status: PlanCard['status'], step = 100): number {
  return genericNextOrderInColumn(cards, status, step)
}

/** 拖到同列某卡片之后应取的 order 值：取相邻两卡 order 的中点；无右侧邻居时 + 步长。 */
export function orderAfter(
  cards: readonly Pick<PlanCard, 'status' | 'order' | 'createdAt' | 'id'>[],
  status: PlanCard['status'],
  afterId: string | null,
  step = 100,
): number {
  return genericOrderAfter(cards, status, afterId, step)
}

/** 拖到同列某卡片之前应取的 order 值：中点；列首 - 步长（order 允许为负）。 */
export function orderBefore(
  cards: readonly Pick<PlanCard, 'status' | 'order' | 'createdAt' | 'id'>[],
  status: PlanCard['status'],
  beforeId: string | null,
  step = 100,
): number {
  return genericOrderBefore(cards, status, beforeId, step)
}

export type PlanCardWithView = PlanCardView
