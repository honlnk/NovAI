import { locateCardContent, nextCardSequence, trashCardFile, writeCardFile } from '../card-board/store'
import { nextOrderInColumn, orderAfter, orderBefore } from '../card-board/ordering'
import { buildRhythmBody, normalizeConflictIntensity, parseRhythmFile, replaceRhythmBodySections, serializeRhythmCard } from './parser'
import {
  createRhythmId,
  createRhythmPath,
  extractRhythmSequence,
} from './identity'
import { hashContent } from '../util/hash'
import { scanRhythmCards, type CardProjectSnapshot } from './catalog'
import {
  RhythmConflictError,
  RhythmError,
} from '../../types/rhythm'
import type {
  RhythmAuthorJudgment,
  RhythmCard,
  RhythmHook,
  RhythmMood,
  RhythmPayoff,
  RhythmStatus,
} from '../../types/rhythm'

/**
 * 节奏卡的领域读写：所有操作以 rhythm/ 目录文件为唯一事实来源（定位/落盘/回收站/
 * 序号原语来自 card-board/store，与伏笔同一模式）。
 *
 * - 读取按 frontmatter.id 定位（文件名只是外部友好，改名不丢卡片）。
 * - 正文三节（节奏意图/上下文衔接/作者备注）分别可替换，未提供的节保持原样；
 *   更新正文任一节必须带 expectedContentHash（防覆盖），只改元数据不要求。
 * - 判定（作者字段控制权计划 §五）：默认自动——保存任一比较值（计划四项 / 实际四项，
 *   自评 actualNote 不算）时按当时阈值以合并后的最新值重算 status / deviation_*，
 *   并记录来源 auto 与所用阈值；非比较字段（卡名/章节/角色/备注/正文/自评）不触发。
 *   作者可经 authorJudgment（§五.2 校验表）显式校正结论，或 restoreAutoJudgment
 *   立即按最新值重算回到自动（作者说明保留为历史）。两个显式操作互斥。
 */

export type CreateRhythmOptions = {
  /** 节奏卡名（如「第083章节奏」）。 */
  name: string
  /** 关联章节（完整路径「卷/章」，如 第二卷/第083章）。 */
  chapterRef: string
  /** 计划冲突强度（1~10 整数）。 */
  plannedConflict: number
  /** 计划情绪基调。 */
  plannedMood: RhythmMood
  /** 计划章末钩子类型。 */
  plannedHook: RhythmHook
  /** 计划爽点类型。 */
  plannedPayoff: RhythmPayoff
  /** 计划出场主要角色；缺省空数组。 */
  plannedCharacters?: readonly string[]
  /** 自然语言补充（如「大高潮后的喘息章」）；缺省空串。 */
  plannedNote?: string
  /** 节奏意图正文；缺省空串。 */
  intentBody?: string
  /** 上下文衔接正文；缺省空串。 */
  linkBody?: string
  /** 作者备注正文；缺省空串。 */
  authorNoteBody?: string
  /**
   * 写后实际值（作者字段控制权计划阶段 3：副本携带完整人工视角用）。
   * 全部缺省 = 纯规划形态创建；提供任一项即按偏差规则判出 written/deviated。
   */
  actualConflict?: number | null
  actualMood?: RhythmMood | null
  actualHook?: RhythmHook | null
  actualPayoff?: RhythmPayoff | null
  /** 本章自评；缺省 null。 */
  actualNote?: string | null
  /**
   * 作者校正（阶段 4 §五.2）：副本携带人工判定视角时使用。校验通过后以作者结论
   * 覆盖自动判定（来源 author，记录当时阈值）；系统 deviationNote 不被触碰。
   */
  authorJudgment?: RhythmAuthorJudgment
  /** 冲突强度偏差阈值（|计划-实际| ≥ 阈值判偏差）；缺省 3。 */
  conflictThreshold?: number
  now?: Date
}

export type UpdateRhythmOptions = {
  id: string
  name?: string
  chapterRef?: string
  /** 计划冲突强度（1~10 整数）。 */
  plannedConflict?: number
  plannedMood?: RhythmMood
  plannedHook?: RhythmHook
  plannedPayoff?: RhythmPayoff
  plannedCharacters?: readonly string[]
  plannedNote?: string
  /** 替换节奏意图正文；不传保持原样。 */
  intentBody?: string
  /** 替换上下文衔接正文；空串 = 清除该节。 */
  linkBody?: string
  /** 替换作者备注正文；空串 = 清除该节。 */
  authorNoteBody?: string
  /** 实际冲突强度；传 null 清除。 */
  actualConflict?: number | null
  /** 实际情绪基调；传 null 清除。 */
  actualMood?: RhythmMood | null
  /** 实际章末钩子；传 null 清除。 */
  actualHook?: RhythmHook | null
  /** 实际爽点类型；传 null 清除。 */
  actualPayoff?: RhythmPayoff | null
  /** 本章节奏自评；传 null 清除。 */
  actualNote?: string | null
  /**
   * 作者校正（阶段 4 §五.2 显式操作）：与应用时快照中的其余字段修改合并为一次保存；
   * 校验通过后结论生效（来源 author）。与 restoreAutoJudgment 互斥。
   */
  authorJudgment?: RhythmAuthorJudgment
  /**
   * 恢复自动判定（阶段 4 §五.3 显式操作）：以合并后的最新比较值与当时阈值立即重算，
   * 来源回到 auto；不清空实际值，作者说明保留为历史。与 authorJudgment 互斥。
   */
  restoreAutoJudgment?: boolean
  /** 移动到目标列某个卡片之后；null = 列末尾。 */
  afterId?: string | null
  /** 移动到目标列某个卡片之前（看板列首落点）；null = 列首。与 afterId 二选一。 */
  beforeId?: string | null
  /** 冲突强度偏差阈值（|计划-实际| ≥ 阈值判偏差）；缺省 3。 */
  conflictThreshold?: number
  now?: Date
  /** 上次读取的文件全文 hash；提供时做冲突检测，更新正文时必传。 */
  expectedContentHash?: string
}

export async function createRhythmCard(
  project: CardProjectSnapshot,
  options: CreateRhythmOptions,
): Promise<RhythmCard> {
  const name = options.name.trim()

  if (!name) {
    throw new RhythmError('节奏卡名不能为空')
  }

  const chapterRef = options.chapterRef.trim()

  if (!chapterRef) {
    throw new RhythmError('关联章节不能为空：节奏卡必须登记在哪一章')
  }

  const plannedConflict = normalizeConflictIntensity(options.plannedConflict, 'planned_conflict')
  const now = options.now ?? new Date()
  const existing = await scanRhythmCards(project)

  // 一章一卡（作者字段控制权计划阶段 3）：目标章号已被其他卡占用时明确拒绝
  assertChapterAvailable(chapterRef, existing.cards, null)

  const order = nextOrderInColumn(existing.cards, 'planned')
  const sequence = nextCardSequence(existing.cards.map((card) => card.sourcePath), extractRhythmSequence)
  const id = createRhythmId(sequence)
  const path = createRhythmPath(id, name)

  // 副本携带完整人工视角：提供任一实际比较值即按偏差规则判出 written/deviated。
  // 自评 actualNote 只是写后记录，不参与状态判定（§五.2：只填自评不构成已写）。
  const actualConflict = options.actualConflict ?? null
  const actualMood = options.actualMood ?? null
  const actualHook = options.actualHook ?? null
  const actualPayoff = options.actualPayoff ?? null
  const actualNote = normalizeNullableText(options.actualNote ?? null)
  const threshold = options.conflictThreshold ?? 3
  const hasComparisonActual = actualConflict !== null || actualMood !== null
    || actualHook !== null || actualPayoff !== null
  const autoDeviation = hasComparisonActual
    ? computeRhythmDeviation(
      { plannedConflict, plannedMood: options.plannedMood, plannedHook: options.plannedHook, plannedPayoff: options.plannedPayoff, actualConflict, actualMood, actualHook, actualPayoff },
      threshold,
    )
    : { deviationFlag: false, deviationNote: null }

  // 判定来源元数据（阶段 4 §五/§八.2）：作者校正覆盖自动结论；系统说明独立留存
  let status: RhythmStatus = deriveAutoStatus(hasComparisonActual, autoDeviation.deviationFlag)
  let deviationFlag = autoDeviation.deviationFlag
  const deviationNote = autoDeviation.deviationNote
  let judgmentSource: RhythmCard['judgmentSource'] = 'auto'
  let authorDeviationNote: string | null = null
  let lastJudgmentThreshold: number | null = null

  if (options.authorJudgment) {
    const corrected = normalizeAuthorJudgment(options.authorJudgment, actualConflict, actualMood, actualHook, actualPayoff)
    status = corrected.status
    deviationFlag = corrected.deviationFlag
    authorDeviationNote = corrected.authorDeviationNote
    judgmentSource = 'author'
  }

  // 有实际比较值（或作者校正）即发生了一次判定：记录所用阈值；纯规划形态不记录
  if (hasComparisonActual || options.authorJudgment) {
    lastJudgmentThreshold = threshold
  }

  const card: Omit<RhythmCard, 'sourcePath'> = {
    id,
    name,
    status,
    order,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    chapterRef,
    plannedConflict,
    plannedMood: options.plannedMood,
    plannedHook: options.plannedHook,
    plannedPayoff: options.plannedPayoff,
    plannedCharacters: options.plannedCharacters ? [...options.plannedCharacters] : [],
    plannedNote: options.plannedNote?.trim() ?? '',
    actualConflict,
    actualMood,
    actualHook,
    actualPayoff,
    actualNote,
    deviationFlag,
    deviationNote,
    judgmentSource,
    authorDeviationNote,
    lastJudgmentThreshold,
    body: buildRhythmBody(options.intentBody ?? '', options.linkBody ?? '', options.authorNoteBody ?? ''),
  }

  await writeCardFile(project, {
    currentPath: null,
    nextPath: path,
    content: serializeRhythmCard(card),
    existingPaths: [],
    errors: rhythmFileErrors(),
  })

  return { ...card, sourcePath: path }
}

export async function readRhythmCard(
  project: CardProjectSnapshot,
  id: string,
): Promise<{ card: RhythmCard; contentHash: string } | null> {
  const scan = await scanRhythmCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    return null
  }

  const parsed = parseRhythmFile(found.path, found.content)
  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    contentHash: hashContent(found.content),
  }
}

export async function updateRhythmCard(
  project: CardProjectSnapshot,
  options: UpdateRhythmOptions,
): Promise<RhythmCard> {
  const scan = await scanRhythmCards(project)
  const found = await locateCardContent(project, scan.cards, options.id)

  if (!found) {
    throw new RhythmError(`节奏卡不存在：${options.id}`)
  }

  const current = parseRhythmFile(found.path, found.content)

  if (options.expectedContentHash && options.expectedContentHash !== hashContent(found.content)) {
    throw new RhythmConflictError('节奏卡文件已被外部修改，请重新读取后再保存', {
      ...current.card,
      id: current.card.id || options.id,
      sourcePath: found.path,
    })
  }

  const hasBodyUpdate = options.intentBody !== undefined
    || options.linkBody !== undefined
    || options.authorNoteBody !== undefined

  // 正文是作者手写内容，覆盖前必须持有读取版本（防外部编辑器改动被静默冲掉）
  if (hasBodyUpdate && !options.expectedContentHash) {
    throw new RhythmError('更新正文前必须先读取节奏卡，并把返回的 contentHash 作为 expectedContentHash 传入')
  }

  const hasFieldUpdate = hasBodyUpdate
    || options.name !== undefined
    || options.chapterRef !== undefined
    || options.plannedConflict !== undefined
    || options.plannedMood !== undefined
    || options.plannedHook !== undefined
    || options.plannedPayoff !== undefined
    || options.plannedCharacters !== undefined
    || options.plannedNote !== undefined
    || options.actualConflict !== undefined
    || options.actualMood !== undefined
    || options.actualHook !== undefined
    || options.actualPayoff !== undefined
    || options.actualNote !== undefined
    || options.authorJudgment !== undefined
    || options.restoreAutoJudgment !== undefined
    || options.afterId !== undefined
    || options.beforeId !== undefined

  if (!hasFieldUpdate) {
    throw new RhythmError('至少提供 name、计划值、正文各节、actual_* 等要更新的字段之一')
  }

  const now = (options.now ?? new Date()).toISOString()
  const allCards = scan.cards

  // 名称
  let name = current.card.name
  if (options.name !== undefined) {
    name = options.name.trim()
    if (!name) {
      throw new RhythmError('节奏卡名不能为空')
    }
  }

  // 关联章节
  let chapterRef = current.card.chapterRef
  if (options.chapterRef !== undefined) {
    chapterRef = options.chapterRef.trim()
    if (!chapterRef) {
      throw new RhythmError('关联章节不能为空')
    }

    // 一章一卡（阶段 3）：换章时目标章号不能已被其他卡占用（保持原章不改不触发）
    assertChapterAvailable(chapterRef, allCards, options.id)
  }

  // 计划值
  const plannedConflict = options.plannedConflict !== undefined
    ? normalizeConflictIntensity(options.plannedConflict, 'planned_conflict')
    : current.card.plannedConflict
  const plannedMood = options.plannedMood ?? current.card.plannedMood
  const plannedHook = options.plannedHook ?? current.card.plannedHook
  const plannedPayoff = options.plannedPayoff ?? current.card.plannedPayoff
  const plannedCharacters = options.plannedCharacters !== undefined
    ? [...options.plannedCharacters]
    : current.card.plannedCharacters
  const plannedNote = options.plannedNote !== undefined ? options.plannedNote.trim() : current.card.plannedNote

  // 正文：三节分别替换，未提供的节保持原样
  let body = current.card.body
  if (hasBodyUpdate) {
    body = replaceRhythmBodySections(body, {
      ...(options.intentBody !== undefined ? { intentBody: options.intentBody } : {}),
      ...(options.linkBody !== undefined ? { linkBody: options.linkBody } : {}),
      ...(options.authorNoteBody !== undefined ? { authorNoteBody: options.authorNoteBody } : {}),
    })
  }

  // 实际值应用：actual_* 提供即覆盖（清除传 null）。自评只是写后记录，不参与判定
  let actualConflict = current.card.actualConflict
  let actualMood = current.card.actualMood
  let actualHook = current.card.actualHook
  let actualPayoff = current.card.actualPayoff
  let actualNote = current.card.actualNote

  if (options.actualConflict !== undefined) {
    actualConflict = options.actualConflict === null
      ? null
      : normalizeConflictIntensity(options.actualConflict, 'actual_conflict')
  }
  if (options.actualMood !== undefined) {
    actualMood = options.actualMood
  }
  if (options.actualHook !== undefined) {
    actualHook = options.actualHook
  }
  if (options.actualPayoff !== undefined) {
    actualPayoff = options.actualPayoff
  }
  if (options.actualNote !== undefined) {
    actualNote = normalizeNullableText(options.actualNote)
  }

  // 判定规则（阶段 4 §五.3）：比较值 = 计划四项 + 实际四项。改任一比较值即按当时
  // 阈值以合并后的最新完整卡片重算并回到自动来源（含作者卡改比较值 → 恢复自动）；
  // 非比较字段（卡名/章节/角色/备注/正文/自评）不触发重算，人工结论原样保留。
  const threshold = options.conflictThreshold ?? 3
  const hasComparisonUpdate = options.plannedConflict !== undefined
    || options.plannedMood !== undefined
    || options.plannedHook !== undefined
    || options.plannedPayoff !== undefined
    || options.actualConflict !== undefined
    || options.actualMood !== undefined
    || options.actualHook !== undefined
    || options.actualPayoff !== undefined

  let status = current.card.status
  let deviationFlag = current.card.deviationFlag
  let deviationNote = current.card.deviationNote
  let judgmentSource = current.card.judgmentSource
  let authorDeviationNote = current.card.authorDeviationNote
  let lastJudgmentThreshold = current.card.lastJudgmentThreshold

  if (options.authorJudgment && options.restoreAutoJudgment) {
    throw new RhythmError('「作者校正」与「恢复自动判定」是两个互斥的判定操作，一次保存只能提交其一')
  }

  if (options.authorJudgment) {
    // 作者校正（§五.2）：以合并后的实际比较值过校验表（同轮字段修改一并生效），
    // 结论直接采用、来源 author；系统 deviationNote 独立留存不被触碰
    const corrected = normalizeAuthorJudgment(options.authorJudgment, actualConflict, actualMood, actualHook, actualPayoff)
    status = corrected.status
    deviationFlag = corrected.deviationFlag
    authorDeviationNote = corrected.authorDeviationNote
    judgmentSource = 'author'
    lastJudgmentThreshold = threshold
  } else if (options.restoreAutoJudgment || hasComparisonUpdate) {
    // 恢复自动（显式操作，不等计时）或保存比较值触发的自动重算：作者说明保留为
    // 历史（§八.2），实际值不清空；全部实际比较值为空时回到规划中、无偏差、无说明
    const hasComparisonActual = actualConflict !== null || actualMood !== null
      || actualHook !== null || actualPayoff !== null
    const deviation = hasComparisonActual
      ? computeRhythmDeviation(
        { plannedConflict, plannedMood, plannedHook, plannedPayoff, actualConflict, actualMood, actualHook, actualPayoff },
        threshold,
      )
      : { deviationFlag: false, deviationNote: null }
    status = deriveAutoStatus(hasComparisonActual, deviation.deviationFlag)
    deviationFlag = deviation.deviationFlag
    deviationNote = deviation.deviationNote
    judgmentSource = 'auto'
    lastJudgmentThreshold = threshold
  }

  // 列内位置
  const statusChanged = status !== current.card.status
  const positionChanged = statusChanged || options.afterId !== undefined || options.beforeId !== undefined
  const nextOrder = positionChanged
    ? (options.beforeId !== undefined
        ? orderBefore(
          allCards.filter((card) => card.id !== options.id),
          status,
          options.beforeId ?? null,
        )
        : orderAfter(
          allCards.filter((card) => card.id !== options.id),
          status,
          options.afterId ?? null,
        ))
    : current.card.order

  const card: Omit<RhythmCard, 'sourcePath'> = {
    id: current.card.id || options.id,
    name,
    status,
    order: nextOrder,
    createdAt: current.card.createdAt,
    updatedAt: now,
    chapterRef,
    plannedConflict,
    plannedMood,
    plannedHook,
    plannedPayoff,
    plannedCharacters,
    plannedNote,
    actualConflict,
    actualMood,
    actualHook,
    actualPayoff,
    actualNote,
    deviationFlag,
    deviationNote,
    judgmentSource,
    authorDeviationNote,
    lastJudgmentThreshold,
    body,
  }

  const nextContent = serializeRhythmCard(card)
  const nextPath = resolveRenamedPath(found.path, card)

  await writeCardFile(project, {
    currentPath: found.path,
    nextPath,
    content: nextContent,
    existingPaths: allCards.map((item) => item.sourcePath),
    errors: rhythmFileErrors(),
  })

  return { ...card, sourcePath: nextPath }
}

export async function deleteRhythmCard(
  project: CardProjectSnapshot,
  id: string,
): Promise<{ card: RhythmCard; trashPath: string }> {
  const scan = await scanRhythmCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    throw new RhythmError(`节奏卡不存在：${id}`)
  }

  const parsed = parseRhythmFile(found.path, found.content)
  const trashPath = await trashCardFile(project, found.path, found.content)

  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    trashPath,
  }
}

/** 偏差判定的输入：一张卡的四个可比维度（计划值 + 实际值）。 */
export type RhythmDeviationInput = {
  plannedConflict: number
  plannedMood: RhythmMood
  plannedHook: RhythmHook
  plannedPayoff: RhythmPayoff
  actualConflict: number | null
  actualMood: RhythmMood | null
  actualHook: RhythmHook | null
  actualPayoff: RhythmPayoff | null
}

/**
 * 偏差判定（计划 §偏差判定规则）：
 * - 冲突强度：|计划 - 实际| ≥ threshold（默认 3）；实际为 null 不比。
 * - 情绪基调：实际非 null 且与计划不一致。
 * - 章末钩子：实际非 null 且「有↔无」翻转；两个都非「无」但类型不同
 *   （悬念→危机）不算偏差——规则只定义有无翻转。
 * - 爽点类型：实际非 null 且与计划不一致。
 * 命中维度的说明按分号拼接（如「冲突强度偏差：计划 3 实际 7；章末钩子翻转：计划 无 实际 悬念」）。
 */
export function computeRhythmDeviation(
  input: RhythmDeviationInput,
  conflictThreshold = 3,
): { deviationFlag: boolean; deviationNote: string | null } {
  const notes: string[] = []

  if (input.actualConflict !== null && Math.abs(input.plannedConflict - input.actualConflict) >= conflictThreshold) {
    notes.push(`冲突强度偏差：计划 ${input.plannedConflict} 实际 ${input.actualConflict}`)
  }

  if (input.actualMood !== null && input.actualMood !== input.plannedMood) {
    notes.push(`情绪基调偏差：计划 ${input.plannedMood} 实际 ${input.actualMood}`)
  }

  if (input.actualHook !== null && (input.plannedHook === '无') !== (input.actualHook === '无')) {
    notes.push(`章末钩子翻转：计划 ${input.plannedHook} 实际 ${input.actualHook}`)
  }

  if (input.actualPayoff !== null && input.actualPayoff !== input.plannedPayoff) {
    notes.push(`爽点类型偏差：计划 ${input.plannedPayoff} 实际 ${input.actualPayoff}`)
  }

  return notes.length > 0
    ? { deviationFlag: true, deviationNote: notes.join('；') }
    : { deviationFlag: false, deviationNote: null }
}

/** 自动判定的状态推导：无实际比较值 → planned；否则按偏差标记 written/deviated。 */
function deriveAutoStatus(hasComparisonActual: boolean, deviationFlag: boolean): RhythmStatus {
  if (!hasComparisonActual) {
    return 'planned'
  }
  return deviationFlag ? 'deviated' : 'written'
}

/**
 * 作者校正校验表（作者字段控制权计划 §五.2）：
 * - 规划中：仅无偏差（允许保留已有实际值，校正分类不清空它们）；
 * - 已写：无偏差或有偏差均可；偏差：仅有偏差——两者都要求四项实际比较值至少
 *   一项已填写（本章自评不计入）；
 * - 有偏差必须带说明；无偏差清除旧作者说明。
 */
function normalizeAuthorJudgment(
  judgment: RhythmAuthorJudgment,
  actualConflict: number | null,
  actualMood: RhythmMood | null,
  actualHook: RhythmHook | null,
  actualPayoff: RhythmPayoff | null,
): { status: RhythmStatus; deviationFlag: boolean; authorDeviationNote: string | null } {
  const hasComparisonActual = actualConflict !== null || actualMood !== null
    || actualHook !== null || actualPayoff !== null
  const note = normalizeNullableText(judgment.deviationNote ?? null)

  if (judgment.status === 'planned' && judgment.deviationFlag) {
    throw new RhythmError('作者校正「规划中」只能搭配无偏差：规划中的卡没有偏差结论')
  }
  if (judgment.status === 'deviated' && !judgment.deviationFlag) {
    throw new RhythmError('作者校正「偏差」必须搭配有偏差：写后无偏差的卡请选「已写」')
  }
  if (judgment.status !== 'planned' && !hasComparisonActual) {
    throw new RhythmError('作者校正「已写 / 偏差」需要冲突、情绪、钩子、爽点四项实际比较值中至少一项已填写（本章自评不计入）')
  }
  if (judgment.deviationFlag && !note) {
    throw new RhythmError('作者校正为有偏差时必须填写偏差说明')
  }

  return {
    status: judgment.status,
    deviationFlag: judgment.deviationFlag,
    authorDeviationNote: judgment.deviationFlag ? note : null,
  }
}

/** 可空文本规范化：trim 后非空才保留，空串/null 统一为 null（与序列化端对齐）。 */
function normalizeNullableText(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * 关联引用中的章号（如「第二卷/第083章-夜行」→ 83）；无法解析返回 null。
 * 与伏笔的全本章号语义同口径：`第083章`≡`第83章`，不比较卷名与标题。
 */
function rhythmChapterNumber(ref: string): number | null {
  const match = /第(\d+)章/.exec(ref)
  return match ? Number(match[1]) : null
}

/**
 * 两个关联引用是否指同一章：都能解析出章号时按章号相等判定；
 * 至少一方无法解析（自由文本）时退回精确字符串比较。
 */
function isSameRhythmChapter(a: string, b: string): boolean {
  const numberA = rhythmChapterNumber(a)
  const numberB = rhythmChapterNumber(b)
  if (numberA !== null && numberB !== null) {
    return numberA === numberB
  }
  return a === b
}

/**
 * 一章一卡守卫（作者字段控制权计划阶段 3）：目标章号已被其他卡占用时抛
 * RhythmError 并指明已有卡片（selfId 用于换章场景排除自己；保持原章不触发）。
 */
function assertChapterAvailable(
  chapterRef: string,
  cards: ReadonlyArray<{ id: string; name: string; chapterRef: string }>,
  selfId: string | null,
): void {
  const occupied = cards.find((card) => card.id !== selfId && isSameRhythmChapter(card.chapterRef, chapterRef))
  if (occupied) {
    const number = rhythmChapterNumber(chapterRef)
    const chapterText = number !== null ? `第${number}章` : chapterRef
    throw new RhythmError(`${chapterText} 已有节奏卡「${occupied.name}」（${occupied.id}）：节奏卡一章一卡，请先处理已有卡片或换一个章节`)
  }
}

/** 节奏卡领域落盘错误文案（占用/回滚）。 */
function rhythmFileErrors() {
  return {
    occupied: (path: string) => new RhythmError(`目标文件已存在：${path}；请换一个节奏卡名`),
    renameFailed: (from: string, to: string, reason: string) =>
      new RhythmError(`重命名失败，旧文件删除出错，已回滚：${from} → ${to}${reason}`),
  }
}

/**
 * 计算改名后的目标路径：保留原标识，只更新可读名称部分。
 * 名称未变化或清理后与现文件名等价时返回原路径（no-op）。
 */
function resolveRenamedPath(currentPath: string, card: Omit<RhythmCard, 'sourcePath'>): string {
  const nextPath = createRhythmPath(card.id, card.name)

  if (nextPath === currentPath) {
    return currentPath
  }

  return nextPath
}
