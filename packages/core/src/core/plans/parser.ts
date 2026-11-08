import { hashContent } from '../util/hash'
import { firstNonEmptyLine, normalizeOrder, normalizeTime, parseFrontmatterLines, splitFrontmatter } from '../card-board/parser'
import { isPlanStatus } from '../../types/plans'
import type { PlanCard, PlanCardView } from '../../types/plans'

/**
 * 计划卡片的解析与序列化。
 *
 * frontmatter 为自研行式解析（与要素 parser 同风格：`key: value`，不支持嵌套），
 * 字段只有五个标量：id/status/order/createdAt/updatedAt。
 * 缺失或非法的元数据不丢正文：status 回退收集箱、非法时间置空串、order 置 0。
 * 拆分/行解析/规范化原语来自 card-board（计划/伏笔/节奏卡共用的通用底层）。
 */

export type ParsedPlanFile = {
  card: Omit<PlanCard, 'sourcePath'>
  /** 正文（frontmatter 之后的全部内容，保留原始缩进，仅去掉首尾空行）。 */
  body: string
  /** 整个文件内容的 hash，供冲突检测（外部修改检测）使用。 */
  contentHash: string
}

export function parsePlanFile(sourcePath: string, content: string): ParsedPlanFile {
  const { frontmatter, body } = splitFrontmatter(content)
  const record = parseFrontmatterLines(frontmatter)

  const bodyText = body.trim()
  const id = (record.id ?? '').trim()
  const rawStatus = (record.status ?? '').trim()
  const status = isPlanStatus(rawStatus) ? rawStatus : 'inbox'
  const order = normalizeOrder(record.order)
  const createdAt = normalizeTime(record.createdAt)
  const updatedAt = normalizeTime(record.updatedAt)

  return {
    card: { id, status, order, createdAt, updatedAt, body: bodyText },
    body: bodyText,
    contentHash: hashContent(content),
  }
}

/**
 * 序列化卡片为完整 Markdown 文件内容（frontmatter + 空行 + 正文）。
 * 元数据字段固定顺序输出；正文原样写入（首尾空行已由写入方 trim）。
 */
export function serializePlanCard(card: Omit<PlanCard, 'sourcePath'>): string {
  const lines = [
    '---',
    `id: ${card.id}`,
    `status: ${card.status}`,
    `order: ${card.order}`,
    `createdAt: ${card.createdAt}`,
    `updatedAt: ${card.updatedAt}`,
    '---',
    '',
    card.body.trim(),
    '',
  ]

  return lines.join('\n')
}

/** 展示标题：正文首个非空行，去掉行首 Markdown 标题标记（# 与后续空格）。 */
export function derivePlanTitle(body: string): string {
  const firstLine = firstNonEmptyLine(body)

  if (!firstLine) {
    return ''
  }

  return firstLine.replace(/^#{1,6}\s*/, '')
}

/**
 * 替换计划名对应的正文行：首个非空行。原行是 Markdown 标题时保留 `#` 层级，
 * 只替换标题文本；普通行只替换文本；首个非空行之后的正文原样保留。
 * 用于改名时保持「名称 = 正文首个非空行」的单一事实来源。
 */
export function replacePlanTitleLine(body: string, title: string): string {
  const lines = body.split('\n')
  const index = lines.findIndex((line) => line.trim().length > 0)

  if (index === -1) {
    // 无正文（不该发生——正文非空由上游校验）：标题就是全部内容
    return title
  }

  const headingMatch = /^(#{1,6})\s*(.*)$/.exec(lines[index]!.trim())
  const replaced = headingMatch ? `${headingMatch[1]} ${title}` : title
  lines[index] = replaced

  return lines.join('\n')
}

/** 正文摘要：首个非空行（不剥标题标记），超出上限截断加省略号。 */
export function derivePlanSummary(body: string, maxLength = 80): string {
  const firstLine = firstNonEmptyLine(body)

  if (!firstLine) {
    return ''
  }

  if (firstLine.length <= maxLength) {
    return firstLine
  }

  return `${firstLine.slice(0, maxLength)}…`
}

export function toPlanCardView(card: PlanCard): PlanCardView {
  return {
    ...card,
    title: derivePlanTitle(card.body),
    summary: derivePlanSummary(card.body),
  }
}
