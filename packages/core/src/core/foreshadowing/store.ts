import { locateCardContent, nextCardSequence, trashCardFile, writeCardFile } from '../card-board/store'
import { nextOrderInColumn, orderAfter } from '../card-board/ordering'
import { buildForeshadowingBody, parseForeshadowingFile, replaceForeshadowingBodySections, serializeForeshadowingCard } from './parser'
import {
  createForeshadowingId,
  createForeshadowingPath,
  extractForeshadowingSequence,
} from './identity'
import { hashContent } from '../util/hash'
import { scanForeshadowingCards, type CardProjectSnapshot } from './catalog'
import {
  ForeshadowingConflictError,
  ForeshadowingError,
} from '../../types/foreshadowing'
import type { ForeshadowingCard, ForeshadowingStatus } from '../../types/foreshadowing'

/**
 * 伏笔卡片的领域读写：所有操作以 foreshadowing/ 目录文件为唯一事实来源
 * （定位/落盘/回收站/序号原语来自 card-board/store，与计划同一模式）。
 *
 * - 读取按 frontmatter.id 定位（文件名只是外部友好，改名不丢卡片）。
 * - 读者视角与作者真相是正文的两节：readerView / authorTruth 分别可替换，
 *   未提供的节保持原样（写正文链路只拿 readerView，也不会误伤真相节）。
 * - 暗示历史（related_chapters）通过 addRelatedChapters 追加（去重保序）。
 * - 状态推进到 revealed/resolved 时可同步登记 resolvedAt（回收章节）；
 *   abandoned 必须给 abandonedReason（避免日后误以为漏写）。
 * - 冲突检测与删除回收站语义同计划：expectedContentHash 校验 + .novel/trash/。
 */

export type CreateForeshadowingOptions = {
  /** 伏笔名（首行会成为读者视角之前的唯一标识名）。 */
  name: string
  /** 读者视角正文（当时可见事实）。 */
  readerView: string
  /** 作者真相正文（剧透）；可省略（先登记后补真相）。 */
  authorTruth?: string
  /** 埋设章节（完整路径「卷/章」）。 */
  plantedAt: string
  status?: ForeshadowingStatus
  payoffWindow?: readonly [string, string] | null
  relatedCharacters?: readonly string[]
  relatedEntities?: readonly string[]
  isRedHerring?: boolean
  now?: Date
}

export type UpdateForeshadowingOptions = {
  id: string
  name?: string
  /** 替换读者视角正文；不传保持原样。 */
  readerView?: string
  /** 替换作者真相正文；空串 = 清除真相节。 */
  authorTruth?: string
  status?: ForeshadowingStatus
  plantedAt?: string
  payoffWindow?: readonly [string, string] | null
  relatedCharacters?: readonly string[]
  relatedEntities?: readonly string[]
  /** 追加暗示历史章节（去重保序；与 relatedChapters 的显式覆盖互斥使用）。 */
  addRelatedChapters?: readonly string[]
  isRedHerring?: boolean
  /** 实际回收章节；传 null 清除。 */
  resolvedAt?: string | null
  /** 放弃原因；状态改为 abandoned 时必填。 */
  abandonedReason?: string | null
  /** 移动到目标列某个卡片之后；null = 列末尾。 */
  afterId?: string | null
  now?: Date
  /** 上次读取的文件全文 hash；提供时做冲突检测。 */
  expectedContentHash?: string
}

export async function createForeshadowingCard(
  project: CardProjectSnapshot,
  options: CreateForeshadowingOptions,
): Promise<ForeshadowingCard> {
  const name = options.name.trim()

  if (!name) {
    throw new ForeshadowingError('伏笔名不能为空')
  }

  const readerView = options.readerView.trim()

  if (!readerView) {
    throw new ForeshadowingError('读者视角不能为空：伏笔登记时必须写下「读者当时能看到什么」')
  }

  const plantedAt = options.plantedAt.trim()

  if (!plantedAt) {
    throw new ForeshadowingError('埋设章节不能为空：伏笔必须登记在哪一章埋下')
  }

  const now = options.now ?? new Date()
  const status = options.status ?? 'planted'
  const existing = await scanForeshadowingCards(project)
  const order = nextOrderInColumn(existing.cards, status)
  const sequence = nextCardSequence(existing.cards.map((card) => card.sourcePath), extractForeshadowingSequence)
  const id = createForeshadowingId(sequence)
  const path = createForeshadowingPath(id, name)
  const card: Omit<ForeshadowingCard, 'sourcePath'> = {
    id,
    name,
    status,
    order,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    plantedAt,
    payoffWindow: options.payoffWindow ?? null,
    relatedCharacters: options.relatedCharacters ? [...options.relatedCharacters] : [],
    relatedEntities: options.relatedEntities ? [...options.relatedEntities] : [],
    relatedChapters: [],
    isRedHerring: options.isRedHerring ?? false,
    resolvedAt: null,
    abandonedReason: null,
    body: buildForeshadowingBody(readerView, options.authorTruth ?? ''),
  }

  await writeCardFile(project, {
    currentPath: null,
    nextPath: path,
    content: serializeForeshadowingCard(card),
    existingPaths: [],
    errors: foreshadowingFileErrors(),
  })

  return { ...card, sourcePath: path }
}

export async function readForeshadowingCard(
  project: CardProjectSnapshot,
  id: string,
): Promise<{ card: ForeshadowingCard; contentHash: string } | null> {
  const scan = await scanForeshadowingCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    return null
  }

  const parsed = parseForeshadowingFile(found.path, found.content)
  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    contentHash: hashContent(found.content),
  }
}

export async function updateForeshadowingCard(
  project: CardProjectSnapshot,
  options: UpdateForeshadowingOptions,
): Promise<ForeshadowingCard> {
  const scan = await scanForeshadowingCards(project)
  const found = await locateCardContent(project, scan.cards, options.id)

  if (!found) {
    throw new ForeshadowingError(`伏笔不存在：${options.id}`)
  }

  const current = parseForeshadowingFile(found.path, found.content)

  if (options.expectedContentHash && options.expectedContentHash !== hashContent(found.content)) {
    throw new ForeshadowingConflictError('伏笔文件已被外部修改，请重新读取后再保存', {
      ...current.card,
      id: current.card.id || options.id,
      sourcePath: found.path,
    })
  }

  const now = (options.now ?? new Date()).toISOString()
  const allCards = scan.cards
  const hasFieldUpdate = options.name !== undefined
    || options.readerView !== undefined
    || options.authorTruth !== undefined
    || options.status !== undefined
    || options.plantedAt !== undefined
    || options.payoffWindow !== undefined
    || options.relatedCharacters !== undefined
    || options.relatedEntities !== undefined
    || options.addRelatedChapters !== undefined
    || options.isRedHerring !== undefined
    || options.resolvedAt !== undefined
    || options.abandonedReason !== undefined
    || options.afterId !== undefined

  if (!hasFieldUpdate) {
    throw new ForeshadowingError('至少提供 name、readerView、authorTruth、status、addRelatedChapters 等要更新的字段之一')
  }

  // 名称
  let name = current.card.name
  if (options.name !== undefined) {
    name = options.name.trim()
    if (!name) {
      throw new ForeshadowingError('伏笔名不能为空')
    }
  }

  // 埋设章节
  let plantedAt = current.card.plantedAt
  if (options.plantedAt !== undefined) {
    plantedAt = options.plantedAt.trim()
    if (!plantedAt) {
      throw new ForeshadowingError('埋设章节不能为空')
    }
  }

  // 状态：abandoned 必须有原因（新给或沿用已有）；revealed/resolved 可同步登记回收章节
  let status = current.card.status
  if (options.status !== undefined) {
    status = options.status
  }

  let abandonedReason = options.abandonedReason !== undefined
    ? (options.abandonedReason?.trim() ? options.abandonedReason.trim() : null)
    : current.card.abandonedReason

  if (status === 'abandoned' && !abandonedReason) {
    throw new ForeshadowingError('放弃伏笔必须登记原因（abandonedReason），避免日后误以为漏写')
  }

  // 回收章节：显式传入优先；状态离开「已收」区间时清掉残留（避免误导后续查账）
  let resolvedAt = options.resolvedAt !== undefined ? options.resolvedAt : current.card.resolvedAt
  if (status !== 'revealed' && status !== 'resolved') {
    resolvedAt = null
  }

  // 正文：读者视角 / 作者真相分别替换，未提供的节保持原样
  let body = current.card.body
  if (options.readerView !== undefined || options.authorTruth !== undefined) {
    const readerView = options.readerView?.trim()
    if (options.readerView !== undefined && !readerView) {
      throw new ForeshadowingError('读者视角不能为空')
    }
    body = replaceForeshadowingBodySections(body, {
      ...(options.readerView !== undefined ? { readerView } : {}),
      ...(options.authorTruth !== undefined ? { authorTruth: options.authorTruth } : {}),
    })
  }

  // 暗示历史：显式追加（去重保序）
  let relatedChapters = [...current.card.relatedChapters]
  if (options.addRelatedChapters !== undefined) {
    for (const chapter of options.addRelatedChapters) {
      const trimmed = chapter.trim()
      if (trimmed && !relatedChapters.includes(trimmed)) {
        relatedChapters.push(trimmed)
      }
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

  const card: Omit<ForeshadowingCard, 'sourcePath'> = {
    id: current.card.id || options.id,
    name,
    status,
    order: nextOrder,
    createdAt: current.card.createdAt,
    updatedAt: now,
    plantedAt,
    payoffWindow: options.payoffWindow !== undefined ? options.payoffWindow : current.card.payoffWindow,
    relatedCharacters: options.relatedCharacters !== undefined ? [...options.relatedCharacters] : current.card.relatedCharacters,
    relatedEntities: options.relatedEntities !== undefined ? [...options.relatedEntities] : current.card.relatedEntities,
    relatedChapters,
    isRedHerring: options.isRedHerring !== undefined ? options.isRedHerring : current.card.isRedHerring,
    resolvedAt,
    abandonedReason,
    body,
  }

  const nextContent = serializeForeshadowingCard(card)
  const nextPath = resolveRenamedPath(found.path, card)

  await writeCardFile(project, {
    currentPath: found.path,
    nextPath,
    content: nextContent,
    existingPaths: allCards.map((item) => item.sourcePath),
    errors: foreshadowingFileErrors(),
  })

  return { ...card, sourcePath: nextPath }
}

/** 伏笔领域落盘错误文案（占用/回滚）。 */
function foreshadowingFileErrors() {
  return {
    occupied: (path: string) => new ForeshadowingError(`目标文件已存在：${path}；请换一个伏笔名`),
    renameFailed: (from: string, to: string, reason: string) =>
      new ForeshadowingError(`重命名失败，旧文件删除出错，已回滚：${from} → ${to}${reason}`),
  }
}

/**
 * 计算改名后的目标路径：保留原标识，只更新可读名称部分。
 * 名称未变化或清理后与现文件名等价时返回原路径（no-op）。
 */
function resolveRenamedPath(currentPath: string, card: Omit<ForeshadowingCard, 'sourcePath'>): string {
  const nextPath = createForeshadowingPath(card.id, card.name)

  if (nextPath === currentPath) {
    return currentPath
  }

  return nextPath
}

export async function deleteForeshadowingCard(
  project: CardProjectSnapshot,
  id: string,
): Promise<{ card: ForeshadowingCard; trashPath: string }> {
  const scan = await scanForeshadowingCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    throw new ForeshadowingError(`伏笔不存在：${id}`)
  }

  const parsed = parseForeshadowingFile(found.path, found.content)
  const trashPath = await trashCardFile(project, found.path, found.content)

  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    trashPath,
  }
}
