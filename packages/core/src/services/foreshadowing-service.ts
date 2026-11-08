import {
  createForeshadowingCard,
  deleteForeshadowingCard,
  readForeshadowingCard,
  scanForeshadowingCards,
  serializeForeshadowingCard,
  sortForeshadowingCards,
  splitForeshadowingBody,
  toForeshadowingCardView as toCardView,
  updateForeshadowingCard,
} from '../core/foreshadowing'
import type {
  CreateForeshadowingOptions,
  UpdateForeshadowingOptions,
} from '../core/foreshadowing/store'
import { hashContent } from '../core/util/hash'
import { FORESHADOWING_STATUSES } from '../types/foreshadowing'
import type { ForeshadowingCard } from '../types/foreshadowing'
import { requireRuntimeProject } from './project-runtime'
import type {
  ForeshadowingBoardView,
  ForeshadowingCardSummaryView,
  ForeshadowingCardView,
  ForeshadowingScanIssueView,
  ForeshadowingStatusView,
} from './types'

/**
 * 伏笔看板服务层：手动面板与 AI 工具共用的唯一入口（状态机、正文分节、冲突规则
 * 只有一个事实来源）。所有操作以 foreshadowing/ 目录文件为事实来源，按 projectId
 * 取运行时快照。
 *
 * 与计划服务层的差异：UI 是作者本人的界面，readForeshadowing 返回的 view 直接
 * 携带作者真相（authorTruth）——truth-hidden 防线（写正文链路只见 readerBody）
 * 在 AI 工具链路上实现，不在本层。
 *
 * contentHash 是文件全文 hash：readForeshadowing 返回给调用方，保存时作为
 * expectedContentHash 回传，检测外部编辑器改动（写入前守卫）。
 */

/**
 * core 的 view 转换（toForeshadowingCardView）刻意不含真相节——它是写正文链路的
 * 防剧透边界。服务层的调用方是作者界面，这里用正文拆分原语把 authorTruth 补齐。
 */
function toForeshadowingCardView(card: ForeshadowingCard, contentHash: string): ForeshadowingCardView {
  const view = toCardView(card)
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    plantedAt: view.plantedAt,
    payoffWindow: view.payoffWindow,
    isRedHerring: view.isRedHerring,
    summary: view.summary,
    sourcePath: view.sourcePath,
    relatedCharacters: [...view.relatedCharacters],
    relatedEntities: [...view.relatedEntities],
    relatedChapters: [...view.relatedChapters],
    resolvedAt: view.resolvedAt,
    abandonedReason: view.abandonedReason,
    readerBody: view.readerBody,
    authorTruth: splitForeshadowingBody(view.body).truthBody,
    contentHash,
  }
}

function toForeshadowingCardSummaryView(card: ForeshadowingCard): ForeshadowingCardSummaryView {
  const view = toCardView(card)
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    plantedAt: view.plantedAt,
    payoffWindow: view.payoffWindow,
    isRedHerring: view.isRedHerring,
    relatedChapters: [...view.relatedChapters],
    summary: view.summary,
    sourcePath: view.sourcePath,
  }
}

/**
 * 扫描伏笔目录并组装看板视图。列固定为六个 frontmatter 状态精确值（不由现有
 * 文件的状态集合决定）：空列也常驻，看板结构稳定，UI 的四列/六列折叠映射才有
 * 完整输入。
 */
export async function getForeshadowingBoard(projectId: string): Promise<ForeshadowingBoardView> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanForeshadowingCards(project)

  const columns = {} as Record<ForeshadowingStatusView, ForeshadowingCardSummaryView[]>
  for (const status of FORESHADOWING_STATUSES) {
    columns[status] = []
  }

  for (const card of sortForeshadowingCards(scan.cards)) {
    columns[card.status].push(toForeshadowingCardSummaryView(card))
  }

  return {
    columns,
    issues: scan.issues.map(toForeshadowingScanIssueView),
  }
}

/** 伏笔摘要列表（可按状态筛选）；AI ListForeshadowing 工具与面板共用。 */
export async function listForeshadowingCards(
  projectId: string,
  status?: ForeshadowingStatusView,
): Promise<ForeshadowingCardSummaryView[]> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanForeshadowingCards(project)
  const cards = status ? scan.cards.filter((card) => card.status === status) : scan.cards
  return sortForeshadowingCards(cards).map(toForeshadowingCardSummaryView)
}

export async function readForeshadowing(projectId: string, id: string): Promise<ForeshadowingCardView | null> {
  const project = requireRuntimeProject(projectId)
  const result = await readForeshadowingCard(project, id)
  return result ? toForeshadowingCardView(result.card, result.contentHash) : null
}

export async function createForeshadowing(
  projectId: string,
  input: Omit<CreateForeshadowingOptions, 'now'>,
): Promise<ForeshadowingCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await createForeshadowingCard(project, input)
  return toForeshadowingCardView(card, hashContent(serializeForeshadowingCard(card)))
}

export async function updateForeshadowing(
  projectId: string,
  input: Omit<UpdateForeshadowingOptions, 'now'>,
): Promise<ForeshadowingCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await updateForeshadowingCard(project, input)
  return toForeshadowingCardView(card, hashContent(serializeForeshadowingCard(card)))
}

export async function deleteForeshadowing(
  projectId: string,
  id: string,
): Promise<{ card: ForeshadowingCardView; trashPath: string }> {
  const project = requireRuntimeProject(projectId)
  const result = await deleteForeshadowingCard(project, id)
  return {
    card: toForeshadowingCardView(result.card, hashContent(serializeForeshadowingCard(result.card))),
    trashPath: result.trashPath,
  }
}

function toForeshadowingScanIssueView(
  issue: Awaited<ReturnType<typeof scanForeshadowingCards>>['issues'][number],
): ForeshadowingScanIssueView {
  return issue
}
