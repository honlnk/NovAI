/**
 * 章节真实新建的纯函数部分（作者字段控制权计划阶段 1）。
 *
 * 命名规范单一事实来源在 core/tools/chapter-name.ts；这里只负责组装文件名、
 * 决定落点目录与校验输入。落盘在 services/chapter-service（新建语义，绝不覆盖）。
 */
import { sanitizeFileNameFragment } from '../card-board/parser'
import type { ChapterCatalog } from '../../types/chapters'

/** 标题留空时的初始标题（作者后续可按现有章节管理方式改名）。 */
export const DEFAULT_CHAPTER_TITLE = '未命名'

/**
 * 组装规范章节文件名：`第NNN章-标题.txt`。
 * 编号至少 3 位补零（与既有最大章号同宽，超过 999 章自然变 4 位）；
 * 标题清理非法字符后为空时回退「未命名」。
 */
export function buildChapterFileName(
  chapterNumber: number,
  title: string | null | undefined,
  padWidth = 3,
): string {
  const numberText = String(chapterNumber).padStart(padWidth, '0')
  const sanitized = sanitizeFileNameFragment(title ?? '') ?? DEFAULT_CHAPTER_TITLE
  return `第${numberText}章-${sanitized}.txt`
}

/**
 * 新建章节的落点目录（相对 chapters/，根为 ''）：跟随当前最新章所在目录，
 * 保持项目的「卷/部」组织；没有任何章节时落在 chapters/ 根。
 * 最新章号出现在多个目录（历史重号）时取路径排序的第一个，确定性优先。
 */
export function resolveCreateTargetDirectory(catalog: ChapterCatalog): string {
  if (catalog.maxNumber === null) {
    return ''
  }

  const latest = catalog.entries.filter(entry => entry.number === catalog.maxNumber)
  return latest[0]?.directory ?? ''
}
