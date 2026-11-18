import { locateCardContent, nextCardSequence, trashCardFile, writeCardFile } from '../card-board/store'
import { nextOrderInColumn, orderAfter } from '../card-board/ordering'
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
  RhythmCard,
  RhythmHook,
  RhythmMood,
  RhythmPayoff,
} from '../../types/rhythm'

/**
 * 节奏卡的领域读写：所有操作以 rhythm/ 目录文件为唯一事实来源（定位/落盘/回收站/
 * 序号原语来自 card-board/store，与伏笔同一模式）。
 *
 * - 读取按 frontmatter.id 定位（文件名只是外部友好，改名不丢卡片）。
 * - 正文三节（节奏意图/上下文衔接/作者备注）分别可替换，未提供的节保持原样；
 *   更新正文任一节必须带 expectedContentHash（防覆盖），只改元数据不要求。
 * - status / deviation_flag / deviation_note 不接受外部设置：回写任一 actual_* 时
 *   系统按偏差判定规则自动计算（computeRhythmDeviation）并流转状态
 *   planned → written（阈值内）/ deviated（超阈）；actual_* 全部清空则回到 planned、
 *   偏差归零（支持作者撤销回写）。不写 actual_* 的更新不碰这三个字段
 *   （手动改计划值不改状态）。
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
  /** 移动到目标列某个卡片之后；null = 列末尾。 */
  afterId?: string | null
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
  const order = nextOrderInColumn(existing.cards, 'planned')
  const sequence = nextCardSequence(existing.cards.map((card) => card.sourcePath), extractRhythmSequence)
  const id = createRhythmId(sequence)
  const path = createRhythmPath(id, name)
  const card: Omit<RhythmCard, 'sourcePath'> = {
    id,
    name,
    status: 'planned',
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
    actualConflict: null,
    actualMood: null,
    actualHook: null,
    actualPayoff: null,
    actualNote: null,
    deviationFlag: false,
    deviationNote: null,
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
    || options.afterId !== undefined

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

  // 实际值回写与偏差自动判定：不写 actual_* 的更新不碰 status / deviation_*。
  // status / deviation_flag / deviation_note 不接受外部设置（类型上就不暴露）。
  const hasActualUpdate = options.actualConflict !== undefined
    || options.actualMood !== undefined
    || options.actualHook !== undefined
    || options.actualPayoff !== undefined
    || options.actualNote !== undefined

  let actualConflict = current.card.actualConflict
  let actualMood = current.card.actualMood
  let actualHook = current.card.actualHook
  let actualPayoff = current.card.actualPayoff
  let actualNote = current.card.actualNote
  let status = current.card.status
  let deviationFlag = current.card.deviationFlag
  let deviationNote = current.card.deviationNote

  if (hasActualUpdate) {
    actualConflict = options.actualConflict !== undefined ? options.actualConflict : actualConflict
    if (actualConflict !== null) {
      actualConflict = normalizeConflictIntensity(actualConflict, 'actual_conflict')
    }

    actualMood = options.actualMood !== undefined ? options.actualMood : actualMood
    actualHook = options.actualHook !== undefined ? options.actualHook : actualHook
    actualPayoff = options.actualPayoff !== undefined ? options.actualPayoff : actualPayoff
    actualNote = options.actualNote !== undefined ? normalizeNullableText(options.actualNote) : actualNote

    const allCleared = actualConflict === null
      && actualMood === null
      && actualHook === null
      && actualPayoff === null
      && actualNote === null

    if (allCleared) {
      // 撤销回写：节奏卡回到纯规划形态
      status = 'planned'
      deviationFlag = false
      deviationNote = null
    } else {
      const deviation = computeRhythmDeviation(
        { plannedConflict, plannedMood, plannedHook, plannedPayoff, actualConflict, actualMood, actualHook, actualPayoff },
        options.conflictThreshold ?? 3,
      )
      deviationFlag = deviation.deviationFlag
      deviationNote = deviation.deviationNote
      status = deviation.deviationFlag ? 'deviated' : 'written'
    }
  }

  // 列内位置
  const statusChanged = status !== current.card.status
  const positionChanged = statusChanged || options.afterId !== undefined
  const nextOrder = positionChanged
    ? orderAfter(
        allCards.filter((card) => card.id !== options.id),
        status,
        options.afterId ?? null,
      )
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

/** 可空文本规范化：trim 后非空才保留，空串/null 统一为 null（与序列化端对齐）。 */
function normalizeNullableText(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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
