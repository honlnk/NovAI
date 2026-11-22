import { hashContent } from '../util/hash'
import { scanCardDirectory, type CardProjectSnapshot } from '../card-board/catalog'
import { parsePlanFile, toPlanCardView } from './parser'
import { isPlanCardPath, sortPlanCards } from './identity'
import type { PlanCard, PlanCardView, PlanScanIssue, PlanScanResult } from '../../types/plans'

/**
 * 计划目录扫描：plans/ 直接子级 .md 文件逐个读取解析。
 *
 * - 目录不存在 / 无文件 → 空结果（旧项目温和获得计划能力，不报错）。
 * - 单文件读取或解析失败不阻塞整个扫描，进 issues 报告。
 * - 缺失元数据（无 frontmatter / 无 id）的文件仍读取展示：默认收集箱、order 0，
 *   id 兜底用文件内容 hash（保证可选中、可修复；修复操作会写回正式标识）。
 * - 重复稳定标识报告不合并：全部保留展示，由修复操作处理。
 *
 * 扫描骨架来自 card-board/catalog（通用底层，计划/伏笔/节奏卡共用）。
 */
export async function scanPlanCards(project: ProjectSnapshotLike): Promise<PlanScanResult> {
  const result = await scanCardDirectory<PlanCardView>(project, {
    directory: 'plans',
    isCardPath: isPlanCardPath,
    sortCards: (cards) => sortPlanCards(cards),
    parseCard(path, content) {
      const parsed = parsePlanFile(path, content)
      const card: PlanCard = {
        ...parsed.card,
        id: parsed.card.id || fallbackId(path, content),
        sourcePath: path,
      }
      return toPlanCardView(card)
    },
  })

  return { cards: result.cards, issues: result.issues as PlanScanIssue[] }
}

export type ProjectSnapshotLike = CardProjectSnapshot

/** 无 id 文件的兜底标识：内容 hash（内容变化时兜底标识随之变化——修复前本就不稳定，可接受）。 */
function fallbackId(path: string, content: string): string {
  return `plan-file-${hashContent(`${path}\n${content}`)}`
}
