import { hashContent } from '../util/hash'
import { scanCardDirectory, type CardProjectSnapshot } from '../card-board/catalog'
import { parseRhythmFile, toRhythmCardView } from './parser'
import { isRhythmCardPath, sortRhythmCards } from './identity'
import type { RhythmCard, RhythmCardView, RhythmScanIssue, RhythmScanResult } from '../../types/rhythm'
import { RHYTHM_DIRECTORY } from '../../types/rhythm'

/**
 * 节奏卡目录扫描：rhythm/ 直接子级 .md 文件逐个读取解析（扫描骨架来自
 * card-board/catalog）。目录不存在 / 无文件 → 空结果（旧项目温和获得节奏卡能力）。
 *
 * 与伏笔的差异：计划值字段（planned_conflict/mood/hook/payoff）必填且无合理默认，
 * 缺失或非法的文件由 parseRhythmFile 抛 RhythmError（reason 指明字段），经扫描骨架
 * 收进 unreadable-file issue——不静默丢字段、也不中断扫描，修复文件后自然恢复。
 * 计划值齐全但缺 id 的手建文件仍读取展示（id 兜底用内容 hash，可选中、可修复）。
 */
export async function scanRhythmCards(project: CardProjectSnapshot): Promise<RhythmScanResult> {
  const result = await scanCardDirectory<RhythmCardView>(project, {
    directory: RHYTHM_DIRECTORY,
    isCardPath: isRhythmCardPath,
    sortCards: (cards) => sortRhythmCards(cards),
    parseCard(path, content) {
      const parsed = parseRhythmFile(path, content)
      const card: RhythmCard = {
        ...parsed.card,
        id: parsed.card.id || fallbackId(path, content),
        sourcePath: path,
      }
      return toRhythmCardView(card)
    },
  })

  return { cards: result.cards, issues: result.issues as RhythmScanIssue[] }
}

export type { CardProjectSnapshot }

/** 无 id 文件的兜底标识：内容 hash（修复前本就不稳定，可接受——与伏笔同款）。 */
function fallbackId(path: string, content: string): string {
  return `rhythm-file-${hashContent(`${path}\n${content}`)}`
}
