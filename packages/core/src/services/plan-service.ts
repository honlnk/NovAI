import {
  createPlanCard,
  deletePlanCard,
  readPlanCard,
  scanPlanCards,
  serializePlanCard,
  sortPlanCards,
  toPlanCardView as toCardView,
  updatePlanCard,
} from '../core/plans'
import { hashContent } from '../core/util/hash'
import { requireRuntimeProject } from './project-runtime'
import type {
  PlanBoardView,
  PlanCardSummaryView,
  PlanCardView,
  PlanScanIssueView,
  PlanStatusView,
} from './types'
import type { PlanCard } from '../types/plans'

/**
 * 计划板服务层：手动面板与 AI 工具共用的唯一入口（元数据、排序、冲突规则
 * 只有一个事实来源）。所有操作以项目文件为事实来源，按 projectId 取运行时快照。
 *
 * contentHash 是文件全文 hash：ReadPlan 返回给调用方，保存时作为
 * expectedContentHash 回传，检测外部编辑器改动（写入前守卫）。
 */

function toPlanCardView(card: PlanCard, contentHash: string): PlanCardView {
  const view = toCardView(card)
  return {
    id: view.id,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    body: view.body,
    sourcePath: view.sourcePath,
    title: view.title,
    summary: view.summary,
    contentHash,
  }
}

function toPlanCardSummaryView(card: PlanCard): PlanCardSummaryView {
  const view = toCardView(card)
  return {
    id: view.id,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    title: view.title,
    summary: view.summary,
    sourcePath: view.sourcePath,
  }
}

/** 扫描计划目录并组装看板视图（每列有序卡片 + 异常报告）。 */
export async function getPlanBoard(projectId: string): Promise<PlanBoardView> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanPlanCards(project)

  const columns: Record<PlanStatusView, PlanCardSummaryView[]> = {
    inbox: [],
    planned: [],
    'in-progress': [],
    done: [],
    'on-hold': [],
  }

  for (const card of sortPlanCards(scan.cards)) {
    columns[card.status].push(toPlanCardSummaryView(card))
  }

  return {
    columns,
    issues: scan.issues.map(toPlanScanIssueView),
  }
}

/** 计划摘要列表（可按状态筛选）；AI ListPlans 工具与面板共用。 */
export async function listPlanCards(projectId: string, status?: PlanStatusView): Promise<PlanCardSummaryView[]> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanPlanCards(project)
  const cards = status ? scan.cards.filter((card) => card.status === status) : scan.cards
  return sortPlanCards(cards).map(toPlanCardSummaryView)
}

export async function readPlan(projectId: string, id: string): Promise<PlanCardView | null> {
  const project = requireRuntimeProject(projectId)
  const result = await readPlanCard(project, id)
  return result ? toPlanCardView(result.card, result.contentHash) : null
}

export async function createPlan(
  projectId: string,
  input: { body: string; status?: PlanStatusView },
): Promise<PlanCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await createPlanCard(project, { body: input.body, status: input.status })
  return toPlanCardView(card, hashContent(serializePlanCard(card)))
}

export async function updatePlan(
  projectId: string,
  input: {
    id: string
    body?: string
    status?: PlanStatusView
    afterId?: string | null
    expectedContentHash?: string
  },
): Promise<PlanCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await updatePlanCard(project, input)
  return toPlanCardView(card, hashContent(serializePlanCard(card)))
}

export async function deletePlan(
  projectId: string,
  id: string,
): Promise<{ card: PlanCardView; trashPath: string }> {
  const project = requireRuntimeProject(projectId)
  const result = await deletePlanCard(project, id)
  return { card: toPlanCardView(result.card, hashContent(serializePlanCard(result.card))), trashPath: result.trashPath }
}

function toPlanScanIssueView(
  issue: Awaited<ReturnType<typeof scanPlanCards>>['issues'][number],
): PlanScanIssueView {
  return issue
}
