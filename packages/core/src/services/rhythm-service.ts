import {
  computeRhythmDeviation,
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
  RhythmDeviationInput,
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
 * 判定来源元数据（阶段 4 §五）随视图透出：手动面板与 AI 读同一份有效结果；
 * authorJudgment / restoreAutoJudgment 只经 updateRhythm 的显式操作参数进入
 * （AI 工具层不接受），阈值待复核（thresholdPending）读取时现算不落盘。
 *
 * contentHash 是文件全文 hash：readRhythm 返回给调用方，保存时作为
 * expectedContentHash 回传，检测外部编辑器改动（写入前守卫）。
 */

function readThreshold(projectId: string): number {
  const project = requireRuntimeProject(projectId)
  return project.config?.settings?.rhythmDeviationThreshold ?? DEFAULT_RHYTHM_DEVIATION_THRESHOLD
}

/**
 * 当前生效的偏差阈值（app 详情的阈值提示文案与保存前预判共用）。
 * 手动保存、AI 工具与这里同一读取口径。
 */
export function readRhythmDeviationThreshold(projectId: string): number {
  return readThreshold(projectId)
}

/**
 * 纯计算：按给定计划/实际比较值与阈值预演自动判定（阶段 4 §五.3「恢复自动
 * 判定」确认界面与「阈值已变化」提示共用口径）。不读运行时项目、不落盘——
 * app 层把磁盘卡与草稿合并后的值传进来（计划四项 + 实际四项），阈值用
 * readRhythmDeviationThreshold 取当前项目值。与 store 的自动重算同一推导：
 * 无实际比较值 → 规划中；否则按偏差标记 written/deviated。
 */
export function computeRhythmJudgmentPreview(
  values: RhythmDeviationInput,
  threshold: number,
): { status: RhythmStatus; deviationFlag: boolean; deviationNote: string | null } {
  const hasComparisonActual = values.actualConflict !== null || values.actualMood !== null
    || values.actualHook !== null || values.actualPayoff !== null
  if (!hasComparisonActual) {
    return { status: 'planned', deviationFlag: false, deviationNote: null }
  }
  const deviation = computeRhythmDeviation(values, threshold)
  return {
    status: deviation.deviationFlag ? 'deviated' : 'written',
    deviationFlag: deviation.deviationFlag,
    deviationNote: deviation.deviationNote,
  }
}

/**
 * 阈值待复核（阶段 4 §五.3）：最近一次判定采用的阈值与当前项目阈值不一致。
 * 读取时比较即可识别，不扫描正文、不重写任何卡片。旧卡未记录阈值（null）时，
 * 只有存在判定形态（实际比较值或作者校正——重算可能改变结果）才按默认 3 解释
 * 并比较；纯规划卡没有可复核的判定，不提示。
 */
function isThresholdPending(card: RhythmCard, currentThreshold: number): boolean {
  if (card.lastJudgmentThreshold !== null) {
    return card.lastJudgmentThreshold !== currentThreshold
  }
  const judgeable = card.actualConflict !== null || card.actualMood !== null
    || card.actualHook !== null || card.actualPayoff !== null
    || card.judgmentSource === 'author'
  return judgeable && DEFAULT_RHYTHM_DEVIATION_THRESHOLD !== currentThreshold
}

function toRhythmCardView(card: RhythmCard, contentHash: string, threshold: number): RhythmCardView {
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
    plannedConflict: view.plannedConflict,
    plannedMood: view.plannedMood,
    plannedHook: view.plannedHook,
    plannedPayoff: view.plannedPayoff,
    actualConflict: view.actualConflict,
    actualMood: view.actualMood,
    actualHook: view.actualHook,
    actualPayoff: view.actualPayoff,
    deviationFlag: view.deviationFlag,
    judgmentSource: view.judgmentSource,
    thresholdPending: isThresholdPending(view, threshold),
    plannedCharacters: [...view.plannedCharacters],
    plannedNote: view.plannedNote,
    actualNote: view.actualNote,
    deviationNote: view.deviationNote,
    authorDeviationNote: view.authorDeviationNote,
    lastJudgmentThreshold: view.lastJudgmentThreshold,
    summary: view.summary,
    intentBody,
    linkBody,
    authorNoteBody,
    sourcePath: view.sourcePath,
    contentHash,
  }
}

function toRhythmCardSummaryView(card: RhythmCard, threshold: number): RhythmCardSummaryView {
  const view = toCardView(card)
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    order: view.order,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    chapterRef: view.chapterRef,
    plannedConflict: view.plannedConflict,
    plannedMood: view.plannedMood,
    plannedHook: view.plannedHook,
    plannedPayoff: view.plannedPayoff,
    actualConflict: view.actualConflict,
    actualMood: view.actualMood,
    actualHook: view.actualHook,
    actualPayoff: view.actualPayoff,
    deviationFlag: view.deviationFlag,
    judgmentSource: view.judgmentSource,
    thresholdPending: isThresholdPending(view, threshold),
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
  const threshold = readThreshold(projectId)

  const columns = {} as Record<RhythmStatusView, RhythmCardSummaryView[]>
  for (const status of RHYTHM_STATUSES) {
    columns[status] = []
  }

  for (const card of sortRhythmCards(scan.cards)) {
    columns[card.status].push(toRhythmCardSummaryView(card, threshold))
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
  const threshold = readThreshold(projectId)
  const cards = status ? scan.cards.filter((card) => card.status === status) : scan.cards
  return sortRhythmCards(cards).map(card => toRhythmCardSummaryView(card, threshold))
}

export async function readRhythm(projectId: string, id: string): Promise<RhythmCardView | null> {
  const project = requireRuntimeProject(projectId)
  const result = await readRhythmCard(project, id)
  return result ? toRhythmCardView(result.card, result.contentHash, readThreshold(projectId)) : null
}

export async function createRhythm(
  projectId: string,
  input: Omit<CreateRhythmOptions, 'now' | 'conflictThreshold'>,
): Promise<RhythmCardView> {
  const project = requireRuntimeProject(projectId)
  const threshold = readThreshold(projectId)
  const card = await createRhythmCard(project, { ...input, conflictThreshold: threshold })
  return toRhythmCardView(card, hashContent(serializeRhythmCard(card)), threshold)
}

export async function updateRhythm(
  projectId: string,
  input: Omit<UpdateRhythmOptions, 'now' | 'conflictThreshold'>,
): Promise<RhythmCardView> {
  const project = requireRuntimeProject(projectId)
  const threshold = readThreshold(projectId)
  const card = await updateRhythmCard(project, {
    ...input,
    conflictThreshold: threshold,
  })
  return toRhythmCardView(card, hashContent(serializeRhythmCard(card)), threshold)
}

export async function deleteRhythm(
  projectId: string,
  id: string,
): Promise<{ card: RhythmCardView; trashPath: string }> {
  const project = requireRuntimeProject(projectId)
  const threshold = readThreshold(projectId)
  const result = await deleteRhythmCard(project, id)
  return {
    card: toRhythmCardView(result.card, hashContent(serializeRhythmCard(result.card)), threshold),
    trashPath: result.trashPath,
  }
}

function toRhythmScanIssueView(
  issue: Awaited<ReturnType<typeof scanRhythmCards>>['issues'][number],
): RhythmScanIssueView {
  return issue
}
