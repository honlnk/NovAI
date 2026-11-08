import { listFilesInDirectory, readProjectTextFile } from '../fs/project-fs'
import type { CardBoardScanIssue, CardBoardScanResult } from '../../types/card-board'

/**
 * 看板卡片目录扫描骨架（计划/伏笔/节奏卡共用）：目录名、路径过滤与单文件解析
 * 由调用方注入；读取/解析失败不阻塞扫描，重复稳定标识报告不合并。
 */

export type CardProjectSnapshot = {
  handle: FileSystemDirectoryHandle
}

export type ScanCardDirectoryOptions<TCard> = {
  /** 卡片目录名（项目根目录下）。 */
  directory: string
  /** 路径是否为本目录下的卡片文件（一般：直接子级 .md）。 */
  isCardPath(path: string): boolean
  /** 单文件解析：内容 → 卡片（含兜底 id 与 sourcePath 填充）。 */
  parseCard(path: string, content: string): TCard
  /** 扫描结果排序（各领域排序原语的单一事实来源）。 */
  sortCards(cards: TCard[]): TCard[]
}

/**
 * 扫描卡片目录：目录不存在 / 无文件 → 空结果（旧项目温和获得该能力，不报错）；
 * 单文件读取或解析失败进 issues；重复稳定标识全部保留展示并报告。
 */
export async function scanCardDirectory<TCard extends { id: string; sourcePath: string }>(
  project: CardProjectSnapshot,
  options: ScanCardDirectoryOptions<TCard>,
): Promise<CardBoardScanResult<TCard>> {
  const paths = await listFilesInDirectory(project.handle, options.directory)
  const cardPaths = paths.filter(options.isCardPath)

  const cards: TCard[] = []
  const issues: CardBoardScanIssue[] = []

  for (const path of cardPaths) {
    try {
      const content = await readProjectTextFile(project.handle, path)
      cards.push(options.parseCard(path, content))
    } catch (error) {
      issues.push({
        kind: 'unreadable-file',
        path,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 重复稳定标识（同目录同 id）：读取时必须报告并允许修复，不能静默合并。
  const byId = new Map<string, TCard[]>()
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

  return { cards: options.sortCards(cards), issues }
}
