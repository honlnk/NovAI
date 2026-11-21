import { hashContent } from '../util/hash'
import {
  firstNonEmptyLine,
  formatFrontmatter,
  formatStringList,
  normalizeOrder,
  normalizeTime,
  parseBoolean,
  parseFrontmatterLines,
  parseNullableString,
  parseStringList,
  splitFrontmatter,
} from '../card-board/parser'
import {
  isForeshadowingStatus,
} from '../../types/foreshadowing'
import type { ForeshadowingCard, ForeshadowingCardView } from '../../types/foreshadowing'
import { formatPlannedPosition, parsePlannedPosition, parsePlannedStart } from './positions'

/**
 * 伏笔卡片的解析与序列化（frontmatter 原语来自 card-board/parser）。
 *
 * - frontmatter 行式解析；列表字段用行内数组 `[a, b]`；非法状态回退 planted、
 *   非法时间置空串——缺失元数据不丢正文。
 * - 正文固定两节：`## 读者视角（当时可见事实）` 与 `## 作者真相`。两节必须分开记
 *   （作者知道钥匙的最终用途，不代表第 9 章的主角也知道）；写正文链路只允许
 *   拿到 readerBody（splitForeshadowingBody 剥掉作者真相节）。
 */

/** 读者视角节标题前缀（兼容「读者视角」「读者视角（当时可见事实）」等写法）。 */
export const READER_SECTION_PREFIX = '读者视角'

/** 作者真相节标题前缀。 */
export const TRUTH_SECTION_PREFIX = '作者真相'

export type ParsedForeshadowingFile = {
  card: Omit<ForeshadowingCard, 'sourcePath'>
  /** 完整正文（含作者真相）。 */
  body: string
  /** 读者视角正文（不含作者真相节）。 */
  readerBody: string
  /** 作者真相正文（无该节时为空串）。 */
  truthBody: string
  /** 整个文件内容的 hash，供冲突检测使用。 */
  contentHash: string
}

export function parseForeshadowingFile(sourcePath: string, content: string): ParsedForeshadowingFile {
  const { frontmatter, body } = splitFrontmatter(content)
  const record = parseFrontmatterLines(frontmatter)

  const bodyText = body.trim()
  const id = (record.id ?? '').trim()
  const name = (record.name ?? '').trim()
  const rawStatus = (record.status ?? '').trim()
  const status = isForeshadowingStatus(rawStatus) ? rawStatus : 'planted'
  const order = normalizeOrder(record.order)
  const createdAt = normalizeTime(record.createdAt)
  const updatedAt = normalizeTime(record.updatedAt)
  const payoffWindow = parsePayoffWindow(record.payoff_window)
  const payoffStart = parsePlannedStart(record.payoff_start)
  const payoffEnd = parsePlannedPosition(record.payoff_end)
  const { readerBody, truthBody } = splitForeshadowingBody(bodyText)

  return {
    card: {
      id,
      name,
      status,
      order,
      createdAt,
      updatedAt,
      plantedAt: (record.planted_at ?? '').trim(),
      payoffWindow,
      payoffStart,
      payoffEnd,
      relatedCharacters: parseStringList(record.related_characters),
      relatedEntities: parseStringList(record.related_entities),
      relatedChapters: parseStringList(record.related_chapters),
      isRedHerring: parseBoolean(record.is_red_herring, false),
      resolvedAt: parseNullableString(record.resolved_at),
      abandonedReason: parseNullableString(record.abandoned_reason),
      body: bodyText,
    },
    body: bodyText,
    readerBody,
    truthBody,
    contentHash: hashContent(content),
  }
}

/**
 * 序列化卡片为完整 Markdown 文件内容（frontmatter + 空行 + 正文）。
 * 领域字段固定顺序输出，看板骨架字段（order/createdAt/updatedAt）收尾。
 * 结构化计划窗口（payoff_start/payoff_end）只在存在时输出——旧卡首次保存
 * 前不写入新增字段，保持「无结构化数据按旧窗口读取」的兼容语义。
 */
export function serializeForeshadowingCard(card: Omit<ForeshadowingCard, 'sourcePath'>): string {
  // 旧内存形状（测试直造的卡片）可能缺新字段；按 null（无结构化数据）处理
  const payoffStart = card.payoffStart ?? null
  const payoffEnd = card.payoffEnd ?? null
  const frontmatter = formatFrontmatter([
    ['id', card.id],
    ['name', card.name],
    ['status', card.status],
    ['planted_at', card.plantedAt],
    ['payoff_window', card.payoffWindow ? formatStringList(card.payoffWindow) : 'null'],
    ...(payoffStart !== null ? ([['payoff_start', formatPlannedPosition(payoffStart)]] as const) : []),
    ...(payoffEnd !== null ? ([['payoff_end', formatPlannedPosition(payoffEnd)]] as const) : []),
    ['related_characters', formatStringList(card.relatedCharacters)],
    ['related_entities', formatStringList(card.relatedEntities)],
    ['related_chapters', formatStringList(card.relatedChapters)],
    ['is_red_herring', card.isRedHerring ? 'true' : 'false'],
    ['resolved_at', card.resolvedAt],
    ['abandoned_reason', card.abandonedReason],
    ['order', String(card.order)],
    ['createdAt', card.createdAt],
    ['updatedAt', card.updatedAt],
  ])

  return [
    frontmatter,
    '',
    card.body.trim(),
    '',
  ].join('\n')
}

/**
 * 拆分正文的读者视角与作者真相：按 `## ` 二级标题分节，标题文本以
 * 「作者真相」开头的节是真相节，其余全部内容（含节前导语与其他节）都是读者侧。
 */
export function splitForeshadowingBody(body: string): { readerBody: string; truthBody: string } {
  const normalized = body.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const truthStart = lines.findIndex((line) => isSectionHeading(line, TRUTH_SECTION_PREFIX))

  if (truthStart === -1) {
    return { readerBody: normalized.trim(), truthBody: '' }
  }

  // 真相节到下一个二级标题（或文末）为止
  let truthEnd = lines.length
  for (let index = truthStart + 1; index < lines.length; index += 1) {
    if (isSectionHeading(lines[index]!, '')) {
      truthEnd = index
      break
    }
  }

  const truthBody = lines.slice(truthStart + 1, truthEnd).join('\n').trim()
  const readerLines = [...lines.slice(0, truthStart), ...lines.slice(truthEnd)]
  const readerBody = readerLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  return { readerBody, truthBody }
}

/** 是否二级节标题；prefix 非空时进一步要求标题文本以 prefix 开头。 */
function isSectionHeading(line: string, prefix: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('## ')) {
    return false
  }

  if (!prefix) {
    return true
  }

  return trimmed.slice(3).trim().startsWith(prefix)
}

/** 由两节内容组装完整正文（创建与模板生成用）；输出为 trim 后的规范形（与解析端一致）。 */
export function buildForeshadowingBody(readerView: string, authorTruth: string): string {
  const sections = [
    `## ${READER_SECTION_PREFIX}（当时可见事实）`,
    '',
    readerView.trim(),
    '',
  ]

  if (authorTruth.trim()) {
    sections.push(`## ${TRUTH_SECTION_PREFIX}`, '', authorTruth.trim(), '')
  }

  return sections.join('\n').trim()
}

/**
 * 替换正文的某一节（保留另一节原样）：readerView 替换读者侧全部内容
 * （真相节以外的所有文本），authorTruth 替换真相节。两节同传时整体重建。
 */
export function replaceForeshadowingBodySections(
  body: string,
  sections: { readerView?: string; authorTruth?: string },
): string {
  const { readerBody, truthBody } = splitForeshadowingBody(body)
  const nextReader = sections.readerView !== undefined ? sections.readerView.trim() : readerBody
  const nextTruth = sections.authorTruth !== undefined ? sections.authorTruth.trim() : truthBody
  return buildForeshadowingBody(nextReader, nextTruth)
}

/** 回收窗口解析：两元素数组 → 区间；单元素/空 → null（单点窗口没有意义，留空让作者补）。 */
function parsePayoffWindow(value: string | undefined): readonly [string, string] | null {
  const items = parseStringList(value)

  if (items.length < 2) {
    return null
  }

  return [items[0]!, items[1]!]
}

export function toForeshadowingCardView(card: ForeshadowingCard): ForeshadowingCardView {
  const { readerBody } = splitForeshadowingBody(card.body)
  return {
    ...card,
    summary: firstNonEmptyLine(readerBody.split('\n').filter((line) => !line.trim().startsWith('## ')).join('\n')),
    readerBody,
  }
}
