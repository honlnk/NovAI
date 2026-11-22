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
  RHYTHM_HOOKS,
  RHYTHM_MOODS,
  RHYTHM_PAYOFFS,
  isRhythmStatus,
  RhythmError,
} from '../../types/rhythm'
import type { RhythmCard, RhythmCardView } from '../../types/rhythm'

/**
 * 节奏卡的解析与序列化（frontmatter 原语来自 card-board/parser）。
 *
 * - frontmatter 行式解析；计划值四字段必填（无合理默认值）：缺失或非法即坏文件，
 *   parseRhythmFile 抛 RhythmError（reason 指明字段），扫描层收进 unreadable-file issue；
 *   actual_* 缺省 null、deviation_flag 缺省 false、planned_characters 缺省空数组。
 * - 非法 status 回退 planned（与伏笔 parser 的状态容错同口径）；时间/排序字段
 *   非法不丢正文（normalizeTime/normalizeOrder 兜底）。
 * - 正文固定三节：`## 节奏意图` / `## 上下文衔接` / `## 作者备注`。意图与衔接必须
 *   分开记（前者是「本章要什么温度」，后者是「前后章的温度差」），作者备注自由。
 */

/** 节奏意图节标题前缀。 */
export const INTENT_SECTION_PREFIX = '节奏意图'

/** 上下文衔接节标题前缀。 */
export const LINK_SECTION_PREFIX = '上下文衔接'

/** 作者备注节标题前缀。 */
export const AUTHOR_NOTE_SECTION_PREFIX = '作者备注'

export type ParsedRhythmFile = {
  card: Omit<RhythmCard, 'sourcePath'>
  /** 完整正文。 */
  body: string
  /** 节奏意图节正文（无该节时为空串）。 */
  intentBody: string
  /** 上下文衔接节正文（无该节时为空串）。 */
  linkBody: string
  /** 作者备注节正文（无该节时为空串）。 */
  authorNoteBody: string
  /** 整个文件内容的 hash，供冲突检测使用。 */
  contentHash: string
}

/**
 * 冲突强度规范化：须为 1~10 的整数，越界/非整数按非法处理（抛 RhythmError）。
 * 解析端（frontmatter 字符串）与写入端（API 数值）共用同一判定。
 */
export function normalizeConflictIntensity(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RhythmError(`${field} 非法：${value}（须为 1~10 的整数）`)
  }

  return value
}

export function parseRhythmFile(sourcePath: string, content: string): ParsedRhythmFile {
  const { frontmatter, body } = splitFrontmatter(content)
  const record = parseFrontmatterLines(frontmatter)

  const bodyText = body.trim()
  const id = (record.id ?? '').trim()
  const name = (record.name ?? '').trim()
  const rawStatus = (record.status ?? '').trim()
  const status = isRhythmStatus(rawStatus) ? rawStatus : 'planned'
  const chapterRef = (record.chapter_ref ?? '').trim()
  const plannedConflict = parseRequiredConflictIntensity(record.planned_conflict, 'planned_conflict')
  const plannedMood = parseRequiredEnum(record.planned_mood, RHYTHM_MOODS, 'planned_mood')
  const plannedHook = parseRequiredEnum(record.planned_hook, RHYTHM_HOOKS, 'planned_hook')
  const plannedPayoff = parseRequiredEnum(record.planned_payoff, RHYTHM_PAYOFFS, 'planned_payoff')
  const { intentBody, linkBody, authorNoteBody } = splitRhythmBody(bodyText)

  return {
    card: {
      id,
      name,
      status,
      order: normalizeOrder(record.order),
      createdAt: normalizeTime(record.created_at),
      updatedAt: normalizeTime(record.updated_at),
      chapterRef,
      plannedConflict,
      plannedMood,
      plannedHook,
      plannedPayoff,
      plannedCharacters: parseStringList(record.planned_characters),
      plannedNote: (record.planned_note ?? '').trim(),
      actualConflict: parseNullableConflictIntensity(record.actual_conflict, 'actual_conflict'),
      actualMood: parseNullableEnum(record.actual_mood, RHYTHM_MOODS, 'actual_mood'),
      actualHook: parseNullableEnum(record.actual_hook, RHYTHM_HOOKS, 'actual_hook'),
      actualPayoff: parseNullableEnum(record.actual_payoff, RHYTHM_PAYOFFS, 'actual_payoff'),
      actualNote: parseNullableString(record.actual_note),
      deviationFlag: parseBoolean(record.deviation_flag, false),
      deviationNote: parseNullableString(record.deviation_note),
      body: bodyText,
    },
    body: bodyText,
    intentBody,
    linkBody,
    authorNoteBody,
    contentHash: hashContent(content),
  }
}

/**
 * 序列化卡片为完整 Markdown 文件内容（frontmatter + 空行 + 正文）。
 * 领域字段按「标识 / 计划值 / 实际值 / 偏差标记 / 看板骨架」分组固定顺序输出，
 * serialize(parse(serialize(card))) 往返无损。
 */
export function serializeRhythmCard(card: Omit<RhythmCard, 'sourcePath'>): string {
  const frontmatter = formatFrontmatter([
    ['id', card.id],
    ['name', card.name],
    ['status', card.status],
    ['chapter_ref', card.chapterRef],
    ['planned_conflict', String(card.plannedConflict)],
    ['planned_mood', card.plannedMood],
    ['planned_hook', card.plannedHook],
    ['planned_payoff', card.plannedPayoff],
    ['planned_characters', formatStringList(card.plannedCharacters)],
    ['planned_note', card.plannedNote],
    ['actual_conflict', card.actualConflict === null ? null : String(card.actualConflict)],
    ['actual_mood', card.actualMood],
    ['actual_hook', card.actualHook],
    ['actual_payoff', card.actualPayoff],
    ['actual_note', card.actualNote],
    ['deviation_flag', card.deviationFlag ? 'true' : 'false'],
    ['deviation_note', card.deviationNote],
    ['order', String(card.order)],
    ['created_at', card.createdAt],
    ['updated_at', card.updatedAt],
  ])

  return [
    frontmatter,
    '',
    card.body.trim(),
    '',
  ].join('\n')
}

/**
 * 拆分正文三节：按 `## ` 二级标题归类到节奏意图 / 上下文衔接 / 作者备注三个桶；
 * 节前导语与未知小节（含标题行）归入节奏意图——意图是主节，与伏笔「其余全归
 * 读者侧」同款口径，保证任何正文拆分都不丢内容。
 */
export function splitRhythmBody(body: string): { intentBody: string; linkBody: string; authorNoteBody: string } {
  const normalized = body.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const buckets: Record<RhythmSectionKey, string[]> = { intent: [], link: [], authorNote: [] }
  let current: RhythmSectionKey = 'intent'

  for (const line of lines) {
    const heading = matchSectionHeading(line)

    if (heading === null) {
      buckets[current].push(line)
      continue
    }

    // 已知节标题行本身丢弃（重建时统一生成）；未知标题行按普通内容保留在当前桶
    if (heading !== 'unknown') {
      current = heading
    } else {
      buckets[current].push(line)
    }
  }

  return {
    intentBody: collapseBlankLines(buckets.intent),
    linkBody: collapseBlankLines(buckets.link),
    authorNoteBody: collapseBlankLines(buckets.authorNote),
  }
}

/** 由三节内容组装完整正文（创建与模板生成用）；衔接/备注为空时不输出该节。 */
export function buildRhythmBody(intentBody: string, linkBody: string, authorNoteBody: string): string {
  const sections = [
    `## ${INTENT_SECTION_PREFIX}`,
    '',
    intentBody.trim(),
    '',
  ]

  if (linkBody.trim()) {
    sections.push(`## ${LINK_SECTION_PREFIX}`, '', linkBody.trim(), '')
  }

  if (authorNoteBody.trim()) {
    sections.push(`## ${AUTHOR_NOTE_SECTION_PREFIX}`, '', authorNoteBody.trim(), '')
  }

  return sections.join('\n').trim()
}

/**
 * 替换正文的某一节（其余节原样保留）：空串 = 清除该节（重建时不再输出标题）。
 */
export function replaceRhythmBodySections(
  body: string,
  sections: { intentBody?: string; linkBody?: string; authorNoteBody?: string },
): string {
  const current = splitRhythmBody(body)
  return buildRhythmBody(
    sections.intentBody !== undefined ? sections.intentBody : current.intentBody,
    sections.linkBody !== undefined ? sections.linkBody : current.linkBody,
    sections.authorNoteBody !== undefined ? sections.authorNoteBody : current.authorNoteBody,
  )
}

export function toRhythmCardView(card: RhythmCard): RhythmCardView {
  const { intentBody } = splitRhythmBody(card.body)
  return { ...card, summary: firstNonEmptyLine(intentBody) }
}

/** 正文节的内部桶名。 */
type RhythmSectionKey = 'intent' | 'link' | 'authorNote'

/** 是否已知节的二级标题；返回节桶名，未知二级标题返回 'unknown'，非标题返回 null。 */
function matchSectionHeading(line: string): RhythmSectionKey | 'unknown' | null {
  const trimmed = line.trim()

  if (!trimmed.startsWith('## ')) {
    return null
  }

  const title = trimmed.slice(3).trim()

  if (title.startsWith(INTENT_SECTION_PREFIX)) {
    return 'intent'
  }

  if (title.startsWith(LINK_SECTION_PREFIX)) {
    return 'link'
  }

  if (title.startsWith(AUTHOR_NOTE_SECTION_PREFIX)) {
    return 'authorNote'
  }

  return 'unknown'
}

/** 桶内容拼接为正文段：压缩 3+ 连续空行，首尾 trim（与伏笔 readerBody 同款规范化）。 */
function collapseBlankLines(lines: readonly string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 必填冲突强度解析：缺失也非法（计划值必填、无合理默认）；
 * 给出值则须为 1~10 整数。
 */
function parseRequiredConflictIntensity(value: string | undefined, field: string): number {
  const trimmed = (value ?? '').trim()

  if (!trimmed || trimmed === 'null') {
    throw new RhythmError(`${field} 缺失：冲突强度须为 1~10 的整数`)
  }

  return normalizeConflictIntensity(Number(trimmed), field)
}

/**
 * 可空冲突强度解析：缺失/'null' → null；给出值则须为 1~10 整数。
 */
function parseNullableConflictIntensity(value: string | undefined, field: string): number | null {
  const trimmed = (value ?? '').trim()

  if (!trimmed || trimmed === 'null') {
    return null
  }

  return normalizeConflictIntensity(Number(trimmed), field)
}

/**
 * 必填枚举解析：缺失也非法（计划值必填）；给出值则必须是合法枚举（中文精确值）。
 */
function parseRequiredEnum<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T {
  const trimmed = (value ?? '').trim()

  if (!trimmed || trimmed === 'null') {
    throw new RhythmError(`${field} 缺失：节奏卡必须填写计划值`)
  }

  if (!(allowed as readonly string[]).includes(trimmed)) {
    throw new RhythmError(`${field} 非法：${trimmed}`)
  }

  return trimmed as T
}

/**
 * 可空枚举解析：缺失/'null' → null；给出值则必须是合法枚举（中文精确值）。
 */
function parseNullableEnum<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | null {
  const trimmed = (value ?? '').trim()

  if (!trimmed || trimmed === 'null') {
    return null
  }

  if (!(allowed as readonly string[]).includes(trimmed)) {
    throw new RhythmError(`${field} 非法：${trimmed}`)
  }

  return trimmed as T
}
