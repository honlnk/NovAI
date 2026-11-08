import {
  locateCardContent, nextCardSequence, trashCardFile, writeCardFile,
} from '../card-board/store'
import { parsePlanFile, replacePlanTitleLine, serializePlanCard } from './parser'
import {
  createPlanId,
  createPlanPath,
  createPlanSlug,
  createTitledPlanFileName,
  extractPlanSequence,
  extractPlanSlug,
  nextOrderInColumn,
  orderAfter,
  sortPlanCards,
} from './identity'
import { scanPlanCards, type ProjectSnapshotLike } from './catalog'
import { hashContent } from '../util/hash'
import { PlanConflictError, PlanError } from '../../types/plans'
import type { PlanCard, PlanStatus } from '../../types/plans'

/**
 * 计划卡片的领域读写：所有操作以 plans/ 目录文件为唯一事实来源。
 *
 * - 读取按 frontmatter.id 定位（文件名只是外部友好，改名不丢卡片）。
 * - 更新支持「只改元数据不动正文」与「全量替换正文」两种；改元数据时以当前文件
 *   的正文为准重写，正文 hash 单独校验，正文与状态更新互不误覆盖。
 * - 冲突检测：调用方持有 expectedContentHash（上次读取的文件全文 hash）；
 *   文件已被外部编辑器 / 用户改过时抛 PlanConflictError，阻止静默覆盖。
 * - 删除 = 移入 .novel/trash/ 回收站（与 DeleteFile 同语义）。
 *
 * 定位/落盘/回收站/序号原语来自 card-board/store（通用底层，计划/伏笔/节奏卡共用）。
 */

export type CreatePlanOptions = {
  body: string
  status?: PlanStatus
  /** 创建时间（测试注入用）；缺省取当前时间。 */
  now?: Date
}

export type UpdatePlanOptions = {
  id: string
  /** 替换后的完整正文；不传则保持原正文。 */
  body?: string
  /**
   * 新计划名（映射正文首个非空行）。与 body 同时提供时以 body 为准（调用方自行
   * 组合好正文）；单独提供时保留原 `#` 层级只替换标题文本。
   * 名称变化时文件名同步改为 计划-<原序号>-<清理后名称>-<原短标识>.md。
   */
  title?: string
  status?: PlanStatus
  /** 移动到目标列某个卡片之后；null = 列末尾。仅与 status 同传时有意义。 */
  afterId?: string | null
  now?: Date
  /** 上次读取的文件全文 hash；提供时做冲突检测。 */
  expectedContentHash?: string
}

export async function createPlanCard(project: ProjectSnapshotLike, options: CreatePlanOptions): Promise<PlanCard> {
  const body = options.body.trim()

  if (!body) {
    throw new PlanError('计划正文不能为空')
  }

  const now = options.now ?? new Date()
  const status = options.status ?? 'inbox'
  const existing = await scanPlanCards(project)
  const order = nextOrderInColumn(existing.cards, status)
  const sequence = nextCardSequence(existing.cards.map((card) => card.sourcePath), extractPlanSequence)
  const id = createPlanId(now)
  const path = createPlanPath(sequence, body)
  const card: Omit<PlanCard, 'sourcePath'> = {
    id,
    status,
    order,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    body,
  }

  await writeCardFile(project, {
    currentPath: null,
    nextPath: path,
    content: serializePlanCard(card),
    existingPaths: [],
    errors: planFileErrors(),
  })

  return { ...card, sourcePath: path }
}

export async function readPlanCard(project: ProjectSnapshotLike, id: string): Promise<{ card: PlanCard; contentHash: string } | null> {
  const scan = await scanPlanCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    return null
  }

  const parsed = parsePlanFile(found.path, found.content)
  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    contentHash: hashContent(found.content),
  }
}

export async function updatePlanCard(project: ProjectSnapshotLike, options: UpdatePlanOptions): Promise<PlanCard> {
  const scan = await scanPlanCards(project)
  const found = await locateCardContent(project, scan.cards, options.id)

  if (!found) {
    throw new PlanError(`计划不存在：${options.id}`)
  }

  const current = parsePlanFile(found.path, found.content)

  if (options.expectedContentHash && options.expectedContentHash !== hashContent(found.content)) {
    throw new PlanConflictError('计划文件已被外部修改，请重新读取后再保存', {
      ...current.card,
      id: current.card.id || options.id,
      sourcePath: found.path,
    })
  }

  const now = (options.now ?? new Date()).toISOString()
  const allCards = scan.cards
  const bodyChanged = options.body !== undefined
  const titleChanged = options.title !== undefined
  let nextBody = (bodyChanged ? options.body ?? '' : current.card.body).trim()

  if (bodyChanged && !nextBody) {
    throw new PlanError('计划正文不能为空')
  }

  if (titleChanged) {
    const title = options.title?.trim() ?? ''
    if (!title) {
      throw new PlanError('计划名不能为空')
    }
    // title 与 body 同传以 body 为准（调用方已组合）；否则替换首个非空行
    if (!bodyChanged) {
      nextBody = replacePlanTitleLine(current.card.body, title).trim()
    }
  }

  const statusChanged = options.status !== undefined && options.status !== current.card.status
  const positionChanged = statusChanged || options.afterId !== undefined
  // 不传 afterId 的新状态按列末尾处理；状态未变且未指定位置时不重算 order。
  const nextOrder = positionChanged
    ? orderAfter(
        allCards.filter((card) => card.id !== options.id),
        options.status ?? current.card.status,
        options.afterId ?? null,
      )
    : current.card.order
  const resolvedOrder = nextOrder ?? current.card.order

  const card: Omit<PlanCard, 'sourcePath'> = {
    id: current.card.id || options.id,
    status: options.status ?? current.card.status,
    order: resolvedOrder,
    createdAt: current.card.createdAt,
    updatedAt: now,
    body: nextBody,
  }

  const nextContent = serializePlanCard(card)
  const nextPath = resolveRenamedPath(found.path, card, titleChanged ? options.title : undefined)

  await writeCardFile(project, {
    currentPath: found.path,
    nextPath,
    content: nextContent,
    existingPaths: allCards.map((card) => card.sourcePath),
    errors: planFileErrors(),
  })

  return { ...card, sourcePath: nextPath }
}

/** 计划领域落盘错误文案（占用/回滚），与历史行为一致。 */
function planFileErrors() {
  return {
    occupied: (path: string) => new PlanError(`目标文件已存在：${path}；请换一个计划名`),
    renameFailed: (from: string, to: string, reason: string) =>
      new PlanError(`重命名失败，旧文件删除出错，已回滚：${from} → ${to}${reason}`),
  }
}

/**
 * 计算改名后的目标路径：保留原序号与原短标识，只更新可读名称部分。
 * 名称未提供或清理后与现文件名等价时返回原路径（no-op）。
 */
function resolveRenamedPath(
  currentPath: string,
  card: Omit<PlanCard, 'sourcePath'>,
  title: string | undefined,
): string {
  if (title === undefined) {
    return currentPath
  }

  const trimmed = title.trim()
  if (!trimmed) {
    return currentPath
  }

  const sequence = extractPlanSequence(currentPath)
  // 短标识优先沿用原文件名的；外部手建文件没有时按当前正文计算一个
  const slug = extractPlanSlug(currentPath) ?? createPlanSlug(card.body)
  const nextName = createTitledPlanFileName(sequence, trimmed, slug)

  if (nextName === currentPath.split('/').pop()) {
    return currentPath
  }

  return `plans/${nextName}`
}

export async function deletePlanCard(project: ProjectSnapshotLike, id: string): Promise<{ card: PlanCard; trashPath: string }> {
  const scan = await scanPlanCards(project)
  const found = await locateCardContent(project, scan.cards, id)

  if (!found) {
    throw new PlanError(`计划不存在：${id}`)
  }

  const parsed = parsePlanFile(found.path, found.content)
  const trashPath = await trashCardFile(project, found.path, found.content)

  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    trashPath,
  }
}

/** 排序导出（服务层看板视图组装用，保持单一排序事实来源）。 */
export { sortPlanCards }
