import { hashContent } from '../util/hash'
import { scanCardDirectory, type CardProjectSnapshot } from '../card-board/catalog'
import { parseForeshadowingFile, toForeshadowingCardView } from './parser'
import { isForeshadowingCardPath, sortForeshadowingCards } from './identity'
import type {
  ForeshadowingCard,
  ForeshadowingCardView,
  ForeshadowingScanIssue,
  ForeshadowingScanResult,
} from '../../types/foreshadowing'
import { FORESHADOWING_DIRECTORY } from '../../types/foreshadowing'

/**
 * 伏笔目录扫描：foreshadowing/ 直接子级 .md 文件逐个读取解析（扫描骨架来自
 * card-board/catalog）。目录不存在 / 无文件 → 空结果（旧项目温和获得伏笔能力）。
 * 缺失元数据的文件仍读取展示（id 兜底用内容 hash，保证可选中、可修复）。
 */
export async function scanForeshadowingCards(project: CardProjectSnapshot): Promise<ForeshadowingScanResult> {
  const result = await scanCardDirectory<ForeshadowingCardView>(project, {
    directory: FORESHADOWING_DIRECTORY,
    isCardPath: isForeshadowingCardPath,
    sortCards: (cards) => sortForeshadowingCards(cards),
    parseCard(path, content) {
      const parsed = parseForeshadowingFile(path, content)
      const card: ForeshadowingCard = {
        ...parsed.card,
        id: parsed.card.id || fallbackId(path, content),
        sourcePath: path,
      }
      return toForeshadowingCardView(card)
    },
  })

  return { cards: result.cards, issues: result.issues as ForeshadowingScanIssue[] }
}

export type { CardProjectSnapshot }

/** 无 id 文件的兜底标识：内容 hash（修复前本就不稳定，可接受——与计划同款）。 */
function fallbackId(path: string, content: string): string {
  return `foreshadowing-file-${hashContent(`${path}\n${content}`)}`
}
