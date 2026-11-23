/**
 * 计划回收位置（作者字段控制权计划阶段 2，计划 §三.5 / §八.1）。
 *
 * 结构化计划位置区分「已有章节 / 固定未来章号 / 相对位置 / 未设置」，终点额外
 * 支持「开放终点」。相对位置在保存时固定基准章号、偏移量与确定目标章号，
 * 之后不随最新章节漂移。卡片同时保留可读旧字段 payoff_window：新版存在结构化
 * 数据时以它为有效值，窗口更新经服务层同步重写旧字段；旧版本没有结构化数据
 * 时仍读取原窗口（首次打开不批量迁移）。
 */
import { parseChapterNumber } from '../tools/chapter-name'
import { ForeshadowingError } from '../../types/foreshadowing'
import type { ForeshadowingCard, PlannedPosition, PlannedWindowEnd } from '../../types/foreshadowing'

/** 开放终点在旧字段中的可读占位（不当作章节引用）。 */
export const OPEN_END_PLACEHOLDER = '开放终点'

/** 文本中「第N章」的章号提取（不一致检测用，宽松匹配补零/裸章号） */
const CHAPTER_NUMBER_IN_TEXT = /第(\d+)章/

/* ---------- 编解码（frontmatter 单行值） ---------- */

/** 编码计划位置为 frontmatter 单行值；raw 原样保留（往返不丢外部写入）。 */
export function formatPlannedPosition(position: PlannedPosition | PlannedWindowEnd): string {
  switch (position.kind) {
    case 'none':
      return 'none'
    case 'open':
      return 'open'
    case 'chapter':
      return `chapter:${position.ref}`
    case 'future':
      return `future:${position.target}`
    case 'relative':
      return `relative:${position.target}:${position.base}:${position.offset}`
    case 'raw':
      return position.raw
  }
}

/**
 * 解析结构化计划位置：字段缺失返回 null（= 无结构化数据，旧卡按旧窗口读取）。
 * 无法识别的值保留原文（raw），界面以待确认呈现，不自动改绑。
 */
export function parsePlannedPosition(value: string | undefined): PlannedPosition | PlannedWindowEnd | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null
  }

  const trimmed = value.trim()

  if (trimmed === 'none') {
    return { kind: 'none' }
  }
  if (trimmed === 'open') {
    return { kind: 'open' }
  }

  if (trimmed.startsWith('chapter:')) {
    const ref = trimmed.slice('chapter:'.length).trim()
    return ref === '' ? { kind: 'raw', raw: trimmed } : { kind: 'chapter', ref }
  }

  if (trimmed.startsWith('future:')) {
    const target = Number(trimmed.slice('future:'.length).trim())
    return Number.isInteger(target) && target >= 1
      ? { kind: 'future', target }
      : { kind: 'raw', raw: trimmed }
  }

  const relative = /^relative:(\d+):(\d+):(\d+)$/u.exec(trimmed)
  if (relative) {
    const [target, base, offset] = [Number(relative[1]), Number(relative[2]), Number(relative[3])] as const
    return target === base + offset
      ? { kind: 'relative', target, base, offset }
    : { kind: 'raw', raw: trimmed }
  }

  return { kind: 'raw', raw: trimmed }
}

/* ---------- 旧窗口（payoff_window）派生 ---------- */

/** 位置的可读旧文本：已有章节保留引用；未来/相对写确定目标章号；raw 原样。 */
function legacyText(position: PlannedPosition): string {
  switch (position.kind) {
    case 'none':
      return ''
    case 'chapter':
      return position.ref
    case 'future':
    case 'relative':
      return `第${position.target}章`
    case 'raw':
      return position.raw
  }
}

/**
 * 由结构化位置派生可读旧窗口（窗口更新后同步重写 payoff_window）：
 * 两端都是确定位置时写起止标识；有起点、无终点（含开放终点）时终点写
 * 「开放终点」占位；两端都未设置保持 null。
 */
export function deriveLegacyPayoffWindow(
  start: PlannedPosition,
  end: PlannedWindowEnd,
): readonly [string, string] | null {
  if (start.kind === 'none' && end.kind === 'none') {
    return null
  }

  const startText = legacyText(start)
  const endText = end.kind === 'open' || end.kind === 'none' ? OPEN_END_PLACEHOLDER : legacyText(end)
  return [startText, endText]
}

/**
 * 由旧窗口反向推导结构化位置（新建面板与 AI 旧字段链路）：
 * 端点是章节引用形态（含纯章号文本）；「开放终点」占位与空终点在有起点时
 * 都解释为开放终点；整体为空表示未设置。原相对位置记录不保留（兼容出口同规则）。
 */
export function derivePositionsFromLegacyWindow(
  window: readonly [string, string] | null,
): { start: PlannedPosition; end: PlannedWindowEnd } {
  if (!window) {
    return { start: { kind: 'none' }, end: { kind: 'none' } }
  }

  const startText = window[0].trim()
  const endText = window[1].trim()

  if (startText === '') {
    return { start: { kind: 'none' }, end: { kind: 'none' } }
  }

  const end: PlannedWindowEnd = endText === '' || endText === OPEN_END_PLACEHOLDER
    ? { kind: 'open' }
    : { kind: 'chapter', ref: endText }

  return { start: { kind: 'chapter', ref: startText }, end }
}

/* ---------- 有效值与一致性 ---------- */

/**
 * 卡片的有效计划窗口：存在结构化数据（任一端非 null）时以它为准，
 * 缺失端按未设置补齐；旧卡无结构化数据时按旧窗口反向推导。
 */
export function effectivePlannedWindow(card: Pick<ForeshadowingCard, 'payoffStart' | 'payoffEnd' | 'payoffWindow'>): {
  start: PlannedPosition
  end: PlannedWindowEnd
} {
  if (card.payoffStart !== null || card.payoffEnd !== null) {
    return {
      start: card.payoffStart ?? { kind: 'none' },
      end: card.payoffEnd ?? { kind: 'none' },
    }
  }
  return derivePositionsFromLegacyWindow(card.payoffWindow)
}

/** 卡片是否带有结构化计划窗口数据（决定有效值来源）。 */
export function hasStructuredPayoffWindow(card: Pick<ForeshadowingCard, 'payoffStart' | 'payoffEnd'>): boolean {
  return card.payoffStart !== null || card.payoffEnd !== null
}

/**
 * 新旧窗口是否不一致（外部修改守卫，计划 §八.1）：结构化数据存在且由它派生的
 * 可读旧窗口与磁盘旧字段不同，界面并列展示两套数据并提供三个固定出口。
 */
/**
 * 端点一致性：按全本章号语义比较——两侧都能解析出章号时比数字（改名/换卷/补零
 * 不算不一致），否则退回字符串比较；空字符串终点视同开放终点占位。
 */
function sameLegacyEndpoint(derived: string, actual: string): boolean {
  const normalizedActual = actual === '' ? OPEN_END_PLACEHOLDER : actual
  const derivedNumber = CHAPTER_NUMBER_IN_TEXT.exec(derived)?.[1]
  const actualNumber = CHAPTER_NUMBER_IN_TEXT.exec(normalizedActual)?.[1]
  if (derivedNumber !== undefined && actualNumber !== undefined) {
    return Number(derivedNumber) === Number(actualNumber)
  }
  return derived === normalizedActual
}

export function payoffWindowMismatch(card: Pick<ForeshadowingCard, 'payoffStart' | 'payoffEnd' | 'payoffWindow'>): boolean {
  if (!hasStructuredPayoffWindow(card)) {
    return false
  }

  const { start, end } = effectivePlannedWindow(card)
  const derived = deriveLegacyPayoffWindow(start, end)
  const actual = card.payoffWindow

  if (derived === null || actual === null) {
    return derived !== actual
  }

  return !sameLegacyEndpoint(derived[0], actual[0]) || !sameLegacyEndpoint(derived[1], actual[1])
}

/* ---------- 章号解析与窗口校验 ---------- */

/** 位置的确定目标章号：未来/相对取保存目标；已有章节按「第N章」解析；其余 null。 */
/**
 * 起点专用的解析收窄：终点允许「开放终点」（open），起点出现 open 属外部写入的
 * 语义错位——按原文保留（raw）不静默改绑，待作者在高级信息中明确处理。
 */
export function parsePlannedStart(value: string | undefined): PlannedPosition | null {
  const parsed = parsePlannedPosition(value)
  return parsed !== null && parsed.kind === 'open'
    ? { kind: 'raw', raw: (value ?? '').trim() }
    : parsed
}

export function plannedPositionTarget(position: PlannedPosition | PlannedWindowEnd): number | null {
  switch (position.kind) {
    case 'chapter':
      return parseChapterNumber(position.ref)
    case 'future':
    case 'relative':
      return position.target
    default:
      return null
  }
}

/**
 * 作者窗口提交的服务端校验（计划 §三.5 / §三.6）：
 * - 相对位置必须有正整数基准与偏移，且目标 = 基准 + 偏移（编码层已保证，
 *   这里兜底外部写入）；
 * - 起点未设置时终点不能有值（先补起点）；
 * - 两端目标章号可解析时，起点不得晚于终点（不写入倒置窗口）。
 */
export function validatePlannedWindow(start: PlannedPosition, end: PlannedWindowEnd): void {
  for (const position of [start, end]) {
    if (position.kind === 'relative') {
      if (position.base < 1 || position.offset < 1 || position.target !== position.base + position.offset) {
        throw new ForeshadowingError(
          `相对位置必须有正整数基准与偏移，且目标章号 = 基准 + 偏移（收到基准 ${position.base}、偏移 ${position.offset}、目标 ${position.target}）`,
        )
      }
    }
    if (position.kind === 'future' && position.target < 1) {
      throw new ForeshadowingError('固定未来章号必须是正整数')
    }
  }

  if (start.kind === 'none' && end.kind !== 'none') {
    throw new ForeshadowingError('回收窗口未设置起点时，不能单独设置终点；请先补起点')
  }

  const startTarget = plannedPositionTarget(start)
  const endTarget = plannedPositionTarget(end)
  if (startTarget !== null && endTarget !== null && startTarget > endTarget) {
    throw new ForeshadowingError(`回收窗口起点（第${startTarget}章）晚于终点（第${endTarget}章），请调整`)
  }
}
