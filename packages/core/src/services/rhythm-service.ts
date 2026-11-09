import {
  createRhythmCard,
  deleteRhythmCard,
  readRhythmCard,
  scanRhythmCards,
  serializeRhythmCard,
  sortRhythmCards,
  splitRhythmBody,
  toRhythmCardView as toCardView,
  updateRhythmCard,
} from '../core/rhythm'
import type {
  CreateRhythmOptions,
  UpdateRhythmOptions,
} from '../core/rhythm/store'
import { hashContent } from '../core/util/hash'
import { DEFAULT_RHYTHM_DEVIATION_THRESHOLD } from '../core/project/defaults'
import { RHYTHM_STATUSES } from '../types/rhythm'
import type { RhythmCard, RhythmStatus } from '../types/rhythm'
import { requireRuntimeProject } from './project-runtime'
import type {
  RhythmBoardView,
  RhythmCardSummaryView,
  RhythmCardView,
  RhythmScanIssueView,
  RhythmStatusView,
} from './types'

/** 正文三节拆分原语（app 层冲突真值展示复用；与 AI 工具同一拆分口径）。 */
export { splitRhythmBody } from '../core/rhythm'

/**
 * 节奏看板服务层：手动面板与 AI 工具共用的唯一入口（与计划/伏笔服务层同款骨架）。
 * 所有操作以 rhythm/ 目录文件为事实来源，按 projectId 取运行时快照。
 *
 * 偏差阈值来自项目设置（config.settings.rhythmDeviationThreshold，normalize 已夹回
 * 1~10；无配置环境回退默认 3）——手动保存与 RhythmUpdate 工具同一判定口径。
 *
 * contentHash 是文件全文 hash：readRhythm 返回给调用方，保存时作为
 * expectedContentHash 回传，检测外部编辑器改动（写入前守卫）。
 */

function readThreshold(projectId: string): number {
  const project = requireRuntimeProject(projectId)
  return project.config?.settings?.rhythmDeviationThreshold ?? DEFAULT_RHYTHM_DEVIATION_THRESHOLD
}

function toRhythmCardView(card: RhythmCard, contentHash: string): RhythmCardView {
  const view = toCardView(card)
  const { intentBody, linkBody, authorNoteBody } = splitRhythmBody(view.body)
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    chapterRef: view.chapterRef,
    volume: view.volume,
    plannedConflict: view.plannedConflict,
    plannedMood: view.plannedMood,
    plannedHook: view.plannedHook,
    plannedPayoff: view.plannedPayoff,
    actualConflict: view.actualConflict,
    actualMood: view.actualMood,
    actualHook: view.actualHook,
    actualPayoff: view.actualPayoff,
    deviationFlag: view.deviationFlag,
    plannedCharacters: [...view.plannedCharacters],
    plannedNote: view.plannedNote,
    actualNote: view.actualNote,
    deviationNote: view.deviationNote,
    summary: view.summary,
    intentBody,
    linkBody,
    authorNoteBody,
    sourcePath: view.sourcePath,
    contentHash,
  }
}

function toRhythmCardSummaryView(card: RhythmCard): RhythmCardSummaryView {
  const view = toCardView(card)
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    chapterRef: view.chapterRef,
    volume: view.volume,
    plannedConflict: view.plannedConflict,
    plannedMood: view.plannedMood,
    plannedHook: view.plannedHook,
    plannedPayoff: view.plannedPayoff,
    actualConflict: view.actualConflict,
    actualMood: view.actualMood,
    actualHook: view.actualHook,
    actualPayoff: view.actualPayoff,
    deviationFlag: view.deviationFlag,
    summary: view.summary,
    sourcePath: view.sourcePath,
  }
}

/**
 * 扫描节奏目录并组装看板视图。列固定为三个状态精确值：空列也常驻，
 * 看板结构稳定（偏差列由 deviation_flag 自动进入，不可手动拖出——UI 层约束）。
 */
export async function getRhythmBoard(projectId: string): Promise<RhythmBoardView> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanRhythmCards(project)

  const columns = {} as Record<RhythmStatusView, RhythmCardSummaryView[]>
  for (const status of RHYTHM_STATUSES) {
    columns[status] = []
  }

  for (const card of sortRhythmCards(scan.cards)) {
    columns[card.status].push(toRhythmCardSummaryView(card))
  }

  return {
    columns,
    issues: scan.issues.map(toRhythmScanIssueView),
  }
}

/** 节奏摘要列表（可按状态筛选）；AI RhythmList 工具与面板共用。 */
export async function listRhythmCards(
  projectId: string,
  status?: RhythmStatus,
): Promise<RhythmCardSummaryView[]> {
  const project = requireRuntimeProject(projectId)
  const scan = await scanRhythmCards(project)
  const cards = status ? scan.cards.filter((card) => card.status === status) : scan.cards
  return sortRhythmCards(cards).map(toRhythmCardSummaryView)
}

export async function readRhythm(projectId: string, id: string): Promise<RhythmCardView | null> {
  const project = requireRuntimeProject(projectId)
  const result = await readRhythmCard(project, id)
  return result ? toRhythmCardView(result.card, result.contentHash) : null
}

export async function createRhythm(
  projectId: string,
  input: Omit<CreateRhythmOptions, 'now'>,
): Promise<RhythmCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await createRhythmCard(project, input)
  return toRhythmCardView(card, hashContent(serializeRhythmCard(card)))
}

export async function updateRhythm(
  projectId: string,
  input: Omit<UpdateRhythmOptions, 'now' | 'conflictThreshold'>,
): Promise<RhythmCardView> {
  const project = requireRuntimeProject(projectId)
  const card = await updateRhythmCard(project, {
    ...input,
    conflictThreshold: readThreshold(projectId),
  })
  return toRhythmCardView(card, hashContent(serializeRhythmCard(card)))
}

export async function deleteRhythm(
  projectId: string,
  id: string,
): Promise<{ card: RhythmCardView; trashPath: string }> {
  const project = requireRuntimeProject(projectId)
  const result = await deleteRhythmCard(project, id)
  return {
    card: toRhythmCardView(result.card, hashContent(serializeRhythmCard(result.card))),
    trashPath: result.trashPath,
  }
}

function toRhythmScanIssueView(
  issue: Awaited<ReturnType<typeof scanRhythmCards>>['issues'][number],
): RhythmScanIssueView {
  return issue
}
