import { hashContent } from '../util/hash'
import { isPlanStatus } from '../../types/plans'
import type { PlanCard, PlanCardView } from '../../types/plans'

/**
 * 计划卡片的解析与序列化。
 *
 * frontmatter 为自研行式解析（与要素 parser 同风格：`key: value`，不支持嵌套），
 * 字段只有五个标量：id/status/order/createdAt/updatedAt。
 * 缺失或非法的元数据不丢正文：status 回退收集箱、非法时间置空串、order 置 0。
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
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) {
    return ''
  }

  return firstLine.replace(/^#{1,6}\s*/, '')
}

/** 正文摘要：首个非空行（不剥标题标记），超出上限截断加省略号。 */
export function derivePlanSummary(body: string, maxLength = 80): string {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

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

function splitFrontmatter(content: string) {
  const normalized = content.replace(/\r\n/g, '\n')

  if (!normalized.startsWith('---\n')) {
    return { frontmatter: '', body: normalized }
  }

  const endIndex = normalized.indexOf('\n---\n', 4)

  if (endIndex === -1) {
    return { frontmatter: '', body: normalized }
  }

  return {
    frontmatter: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 5),
  }
}

function parseFrontmatterLines(raw: string): Record<string, string> {
  const record: Record<string, string> = {}

  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.trim()

    if (!line) {
      continue
    }

    const separatorIndex = line.indexOf(':')

    if (separatorIndex === -1) {
      continue
    }

    record[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim()
  }

  return record
}

function normalizeOrder(value: string | undefined): number {
  const parsed = Number((value ?? '').trim())

  if (!Number.isFinite(parsed)) {
    return 0
  }

  return parsed
}

/** 非法时间不影响正文读取：解析失败置空串（展示层按「未知」处理）。 */
function normalizeTime(value: string | undefined): string {
  const trimmed = (value ?? '').trim()

  if (!trimmed) {
    return ''
  }

  return Number.isNaN(Date.parse(trimmed)) ? '' : trimmed
}
