import { listFilesInDirectory, readProjectTextFile } from '../fs/project-fs'
import { parsePlanFile, toPlanCardView } from './parser'
import { isPlanCardPath, sortPlanCards } from './identity'
import { hashContent } from '../util/hash'
import type { PlanCard, PlanCardView, PlanScanIssue, PlanScanResult } from '../../types/plans'

/**
 * 计划目录扫描：plans/ 直接子级 .md 文件逐个读取解析。
 *
 * - 目录不存在 / 无文件 → 空结果（旧项目温和获得计划能力，不报错）。
 * - 单文件读取或解析失败不阻塞整个扫描，进 issues 报告。
 * - 缺失元数据（无 frontmatter / 无 id）的文件仍读取展示：默认收集箱、order 0，
 *   id 兜底用文件内容 hash（保证可选中、可修复；修复操作会写回正式标识）。
 * - 重复稳定标识报告不合并：全部保留展示，由修复操作处理。
 */
export async function scanPlanCards(project: ProjectSnapshotLike): Promise<PlanScanResult> {
  const paths = await listFilesInDirectory(project.handle, 'plans')
  const cardPaths = paths.filter(isPlanCardPath)

  const cards: PlanCardView[] = []
  const issues: PlanScanIssue[] = []

  for (const path of cardPaths) {
    try {
      const content = await readProjectTextFile(project.handle, path)
      const parsed = parsePlanFile(path, content)
      const card: PlanCard = {
        ...parsed.card,
        id: parsed.card.id || fallbackId(path, content),
        sourcePath: path,
      }
      cards.push(toPlanCardView(card))
    } catch (error) {
      issues.push({
        kind: 'unreadable-file',
        path,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 重复稳定标识报告（同目录同 id）：读取时必须报告并允许修复，不能静默合并。
  const byId = new Map<string, PlanCardView[]>()
  for (const card of cards) {
    const group = byId.get(card.id) ?? []
    group.push(card)
    byId.set(card.id, group)
  }

  for (const [id, group] of byId) {
    if (group.length > 1) {
      issues.push({ kind: 'duplicate-id', id, paths: group.map((card) => card.sourcePath) })
    }
  }

  return { cards: sortPlanCards(cards), issues }
}

export type ProjectSnapshotLike = {
  handle: FileSystemDirectoryHandle
}

/** 无 id 文件的兜底标识：内容 hash（内容变化时兜底标识随之变化——修复前本就不稳定，可接受）。 */
function fallbackId(path: string, content: string): string {
  return `plan-file-${hashContent(`${path}\n${content}`)}`
}
