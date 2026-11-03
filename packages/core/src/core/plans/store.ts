import {
  readProjectTextFile,
  removeProjectFile,
  writeProjectTextFile,
} from '../fs/project-fs'
import { createTrashPath } from '../fs/trash'
import { parsePlanFile, serializePlanCard } from './parser'
import { createPlanId, createPlanPath, extractPlanSequence, nextOrderInColumn, orderAfter, sortPlanCards } from './identity'
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
  const sequence = nextSequence(existing.cards.map((card) => card.sourcePath))
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

  await writeProjectTextFile(project.handle, path, serializePlanCard(card))

  return { ...card, sourcePath: path }
}

export async function readPlanCard(project: ProjectSnapshotLike, id: string): Promise<{ card: PlanCard; contentHash: string } | null> {
  const found = await locatePlanFile(project, id)

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
  const found = await locatePlanFile(project, options.id)

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
  const allCards = await scanPlanCards(project)
  const bodyChanged = options.body !== undefined
  const nextBody = (bodyChanged ? options.body ?? '' : current.card.body).trim()

  if (bodyChanged && !nextBody) {
    throw new PlanError('计划正文不能为空')
  }

  const statusChanged = options.status !== undefined && options.status !== current.card.status
  const positionChanged = statusChanged || options.afterId !== undefined
  // 不传 afterId 的新状态按列末尾处理；状态未变且未指定位置时不重算 order。
  const nextOrder = positionChanged
    ? orderAfter(
        allCards.cards.filter((card) => card.id !== options.id),
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

  await writeProjectTextFile(project.handle, found.path, serializePlanCard(card))

  return { ...card, sourcePath: found.path }
}

export async function deletePlanCard(project: ProjectSnapshotLike, id: string): Promise<{ card: PlanCard; trashPath: string }> {
  const found = await locatePlanFile(project, id)

  if (!found) {
    throw new PlanError(`计划不存在：${id}`)
  }

  const parsed = parsePlanFile(found.path, found.content)
  const trashPath = createTrashPath(found.path)

  await writeProjectTextFile(project.handle, trashPath, found.content)
  await removeProjectFile(project.handle, found.path)

  return {
    card: { ...parsed.card, id: parsed.card.id || id, sourcePath: found.path },
    trashPath,
  }
}

/** 按稳定标识定位计划文件：扫描目录，按 frontmatter.id 匹配。 */
async function locatePlanFile(project: ProjectSnapshotLike, id: string): Promise<{ path: string; content: string } | null> {
  const scan = await scanPlanCards(project)

  for (const card of scan.cards) {
    if (card.id !== id) {
      continue
    }

    try {
      return { path: card.sourcePath, content: await readProjectTextFile(project.handle, card.sourcePath) }
    } catch {
      return null
    }
  }

  return null
}

/** 下一个创建时序号：现有文件序号最大值 + 1（从 1 开始；删除后允许不连续）。 */
function nextSequence(paths: readonly string[]): number {
  const max = paths.reduce((current, path) => {
    const sequence = extractPlanSequence(path)
    return sequence === null ? current : Math.max(current, sequence)
  }, 0)

  return max + 1
}

/** 排序导出（服务层看板视图组装用，保持单一排序事实来源）。 */
export { sortPlanCards }
