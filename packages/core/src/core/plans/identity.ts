import { hashContent } from '../util/hash'
import { PLANS_DIRECTORY } from '../../types/plans'
import type { PlanCard, PlanCardView } from '../../types/plans'

/**
 * 稳定标识与文件名。
 *
 * 文件名「计划-<创建时序号>-<稳定短标识>.md」在创建时确定，后续修改正文不重命名。
 * 稳定标识 = 时间戳 + 随机串 + 内容 hash 片段，独立于文件名存在（文件改名不影响定位，
 * 因为读取时以 frontmatter.id 为准；文件名只用于外部浏览友好）。
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

/** 组装卡片文件名：计划-<序号>-<短标识>.md。 */
export function createPlanFileName(sequence: number, content: string): string {
  const slug = createPlanSlug(content)
  return `计划-${sequence}-${slug}.md`
}

/** 组装卡片项目内相对路径。 */
export function createPlanPath(sequence: number, content: string): string {
  return `${PLANS_DIRECTORY}/${createPlanFileName(sequence, content)}`
}

/** 从文件名提取创建时序号；提取不出（外部手建文件）返回 null。 */
export function extractPlanSequence(sourcePath: string): number | null {
  const name = sourcePath.split('/').pop() ?? ''
  const match = /^计划-(\d+)-/.exec(name)
  return match ? Number(match[1]) : null
}

const PLAN_FILE_PATTERN = /^计划-(\d+)-[0-9a-z]+\.md$/

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
  return [...cards].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order
    }

    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 目标列末尾的新 order 值：比该列当前最大 order 大一个步长。 */
export function nextOrderInColumn(cards: readonly Pick<PlanCard, 'status' | 'order'>[], status: PlanCard['status'], step = 100): number {
  const max = cards
    .filter((card) => card.status === status)
    .reduce((current, card) => Math.max(current, card.order), Number.NEGATIVE_INFINITY)

  return max === Number.NEGATIVE_INFINITY ? 0 : max + step
}

/** 拖到同列某卡片之后应取的 order 值：取相邻两卡 order 的中点；无右侧邻居时 + 步长。 */
export function orderAfter(
  cards: readonly Pick<PlanCard, 'status' | 'order' | 'createdAt' | 'id'>[],
  status: PlanCard['status'],
  afterId: string | null,
  step = 100,
): number {
  const column = sortPlanCards(cards.filter((card) => card.status === status))

  if (afterId === null) {
    return column.length === 0 ? 0 : (column[column.length - 1]?.order ?? 0) + step
  }

  const index = column.findIndex((card) => card.id === afterId)
  const target = column[index]

  if (!target) {
    return nextOrderInColumn(column, status, step)
  }

  const next = column[index + 1]

  if (!next) {
    return target.order + step
  }

  return (target.order + next.order) / 2
}

export type PlanCardWithView = PlanCardView
