import { computed } from 'vue'
import { defineStore } from 'pinia'

import {
  createForeshadowing,
  deleteForeshadowing,
  deriveLegacyPayoffWindow,
  derivePositionsFromLegacyWindow,
  effectivePlannedWindow,
  formatPlannedPosition,
  getForeshadowingBoard,
  parsePlannedPosition,
  parsePlannedStart,
  payoffWindowMismatch,
  readForeshadowing,
  updateForeshadowing,
  validatePlannedWindow,
} from '@novai/core/services/foreshadowing-service'
import type {
  ForeshadowingBoardView,
  ForeshadowingCardSummaryView,
  ForeshadowingCardView,
  ForeshadowingStatusView,
} from '@novai/core/services/types'
import type { PlannedPosition, PlannedWindowEnd } from '@novai/core/types/foreshadowing'
import { ForeshadowingConflictError, FORESHADOWING_STATUS_LABELS } from '@novai/core/types/foreshadowing'
import { createCardBoardCore } from './card-board'

/**
 * 伏笔账本 store：与计划板同一套看板机件（stores/card-board.ts），只声明伏笔
 * 领域差异——正文三件 + 状态 + 高级信息（作者字段控制权计划阶段 2）共一份草稿，
 * 保存时携带读取时 hash，改伏笔名同步重命名文件在 core 层完成。
 *
 * UI 是作者本人的界面，作者真相直接可读可编辑（创作心智模块施工计划 §七）；
 * truth-hidden 防线只在 AI 工具链路（ReadForeshadowing 永不含真相）。
 *
 * 高级信息草稿的形状受恢复镜像（PersistedCardDraft = string|number|null）约束：
 * 计划位置存编码字符串（formatPlannedPosition 产物），关联章节存换行连接的
 * 引用列表，红鲱鱼存 0/1，实际回收章节空串 = 清除。
 */

/** 伏笔编辑草稿：null 字段 = 该字段未修改 */
export type ForeshadowingDraft = {
  name: string | null
  readerView: string | null
  authorTruth: string | null
  /** 待保存的普通状态；「已放弃」走原因确认流程（不进草稿） */
  status: ForeshadowingStatusView | null
  // —— 高级信息（阶段 2；镜像只收 string|number|null）——
  /** 埋设章节引用（选择器产出；兼容原文原样保存） */
  plantedAt: string | null
  /** 计划窗口起点编码（'none'/'chapter:…'/'future:N'/'relative:T:B:O'/原文） */
  payoffStart: string | null
  /** 计划窗口终点编码（另含 'open'） */
  payoffEnd: string | null
  /** 关联角色输入（顿号/逗号分隔；保存时去空白去重） */
  relatedCharactersText: string | null
  /** 关联物品/实体输入（同上） */
  relatedEntitiesText: string | null
  /** 关联章节（暗示历史）：换行连接的引用列表，顺序即作者排列 */
  relatedChapters: string | null
  /** 红鲱鱼（0/1；镜像布尔约束） */
  isRedHerring: number | null
  /** 实际回收章节引用；空串 = 清除该事实记录 */
  resolvedAt: string | null
}

/** 新建面板输入：伏笔名/读者视角/埋设章节必填，作者真相与回收窗口可选（位置编码） */
export type ForeshadowingCreateDraft = {
  name: string
  readerView: string
  authorTruth: string
  plantedAt: string
  payoffStart: string
  payoffEnd: string
}

const EMPTY_DRAFT: ForeshadowingDraft = {
  name: null,
  readerView: null,
  authorTruth: null,
  status: null,
  plantedAt: null,
  payoffStart: null,
  payoffEnd: null,
  relatedCharactersText: null,
  relatedEntitiesText: null,
  relatedChapters: null,
  isRedHerring: null,
  resolvedAt: null,
}

/** 多项输入分隔：中英文逗号/顿号/分号/换行 */
const TAG_INPUT_SEPARATOR = /[,，、;；\n]+/

function splitTagInput(text: string): string[] {
  const result: string[] = []
  for (const raw of text.split(TAG_INPUT_SEPARATOR)) {
    const item = raw.trim()
    if (item !== '' && !result.includes(item)) {
      result.push(item)
    }
  }
  return result
}

function joinTagInput(values: readonly string[]): string {
  return values.join('、')
}

/** 关联章节草稿文本 → 引用数组（去空白去重保首次出现位置；与 core 落盘口径一致） */
function splitChapterList(text: string): string[] {
  const result: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line !== '' && !result.includes(line)) {
      result.push(line)
    }
  }
  return result
}

function joinChapterList(values: readonly string[]): string {
  return values.join('\n')
}

/** 卡片当前有效计划窗口的编码形态（旧卡按旧窗口反向推导；比较口径统一） */
function effectivePositionEncoding(card: ForeshadowingCardView): { start: string; end: string } {
  const { start, end } = effectivePlannedWindow(card)
  return { start: formatPlannedPosition(start), end: formatPlannedPosition(end) }
}

/** 计划窗口的展示文本（起点 ~ 终点；开放终点用占位；未设置明确说未设置） */
export function plannedWindowDisplay(start: PlannedPosition, end: PlannedWindowEnd): string {
  const legacy = deriveLegacyPayoffWindow(start, end)
  return legacy === null ? '未设置' : `${legacy[0]} ~ ${legacy[1]}`
}

/** 高级字段的变更集合：saveCard 提交、快照覆盖与展示共用同一比较口径 */
function advancedChanges(card: ForeshadowingCardView, draft: ForeshadowingDraft) {
  // 新字段判空一律宽松（!= null）：阶段 2 之前的恢复镜像没有这些字段，读到
  // undefined 不算修改，避免旧记录恢复后被误判有修改而立即写盘
  const effective = effectivePlannedWindow(card)
  const plantedAt = draft.plantedAt != null ? draft.plantedAt.trim() : ''
  const plantedAtChanged = draft.plantedAt != null && plantedAt !== '' && plantedAt !== card.plantedAt

  const start: PlannedPosition = draft.payoffStart != null
    ? (parsePlannedStart(draft.payoffStart) ?? { kind: 'none' })
    : effective.start
  const end: PlannedWindowEnd = draft.payoffEnd != null
    ? (parsePlannedPosition(draft.payoffEnd) ?? { kind: 'none' })
    : effective.end
  const encoding = effectivePositionEncoding(card)
  const startChanged = draft.payoffStart != null && draft.payoffStart !== encoding.start
  const endChanged = draft.payoffEnd != null && draft.payoffEnd !== encoding.end

  const characters = splitTagInput(draft.relatedCharactersText ?? '')
  const charactersChanged = draft.relatedCharactersText != null && characters.join('\n') !== card.relatedCharacters.join('\n')
  const entities = splitTagInput(draft.relatedEntitiesText ?? '')
  const entitiesChanged = draft.relatedEntitiesText != null && entities.join('\n') !== card.relatedEntities.join('\n')

  const chapters = splitChapterList(draft.relatedChapters ?? '')
  const chaptersChanged = draft.relatedChapters != null && chapters.join('\n') !== card.relatedChapters.join('\n')

  const redHerring = draft.isRedHerring != null ? draft.isRedHerring === 1 : null
  const redHerringChanged = redHerring !== null && redHerring !== card.isRedHerring

  const resolvedAt = draft.resolvedAt != null ? draft.resolvedAt.trim() : ''
  const resolvedAtChanged = draft.resolvedAt != null && resolvedAt !== (card.resolvedAt ?? '')

  return {
    plantedAt,
    plantedAtChanged,
    start,
    end,
    startChanged,
    endChanged,
    characters,
    charactersChanged,
    entities,
    entitiesChanged,
    chapters,
    chaptersChanged,
    redHerring,
    redHerringChanged,
    resolvedAt,
    resolvedAtChanged,
  }
}

/**
 * 高级信息校验（计划 §三.6）：非法输入只阻止当前卡片写入并给出具体字段错误，
 * 不清空、不跳走、不把合法字段先写一半。返回 null = 通过。
 */
function validateAdvancedDraft(card: ForeshadowingCardView, draft: ForeshadowingDraft): string | null {
  if (draft.plantedAt != null && draft.plantedAt.trim() === '') {
    return '埋设章节不能为空'
  }
  if (draft.payoffStart != null || draft.payoffEnd != null) {
    const changes = advancedChanges(card, draft)
    try {
      validatePlannedWindow(changes.start, changes.end)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return null
}

/**
 * 草稿与卡片是否有实际差异（null = 未修改）。status 与 isRedHerring 判定用宽松
 * null（!= null）：阶段 1 之前的镜像记录没有这些字段，恢复路径读到 undefined
 * 不算差异，避免旧记录恢复后被误判有修改而立即写盘。
 */
function draftDiffers(card: ForeshadowingCardView, draft: ForeshadowingDraft): boolean {
  const changes = advancedChanges(card, draft)
  return (draft.name !== null && draft.name.trim() !== card.name)
    || (draft.readerView !== null && draft.readerView !== card.readerBody)
    || (draft.authorTruth !== null && draft.authorTruth !== card.authorTruth)
    || (draft.status != null && draft.status !== card.status)
    || changes.plantedAtChanged
    || changes.startChanged
    || changes.endChanged
    || changes.charactersChanged
    || changes.entitiesChanged
    || changes.chaptersChanged
    || changes.redHerringChanged
    || changes.resolvedAtChanged
}

function hasCreateInput(draft: ForeshadowingCreateDraft): boolean {
  return draft.name.trim() !== '' && draft.readerView.trim() !== '' && draft.plantedAt.trim() !== ''
}

export const useForeshadowingStore = defineStore('foreshadowing', () => {
  const core = createCardBoardCore<
    ForeshadowingStatusView,
    ForeshadowingCardSummaryView,
    ForeshadowingBoardView,
    ForeshadowingCardView,
    ForeshadowingDraft,
    ForeshadowingCreateDraft
  >({
    loadBoard: (projectId) => getForeshadowingBoard(projectId),
    readCard: (projectId, id) => readForeshadowing(projectId, id),
    // 保存组合：只提交有实际变化的字段，普通状态、正文与高级信息同一次写入
    // （计划 §七.2 整次提交原子落盘），携带读取时 hash；高级信息先过字段校验，
    // 非法输入以保存失败形态停住（保草稿、显示具体错误、不写一半）
    saveCard: (projectId, card, draft, options) => {
      const validation = validateAdvancedDraft(card, draft)
      if (validation !== null) {
        throw new Error(validation)
      }
      const changes = advancedChanges(card, draft)
      const name = draft.name?.trim()
      const nameChanged = draft.name !== null && name !== card.name
      const readerChanged = draft.readerView !== null && draft.readerView !== card.readerBody
      const truthChanged = draft.authorTruth !== null && draft.authorTruth !== card.authorTruth
      const statusChanged = draft.status != null && draft.status !== card.status
      return updateForeshadowing(projectId, {
        id: card.id,
        ...(nameChanged ? { name: name ?? '' } : {}),
        ...(readerChanged ? { readerView: draft.readerView ?? '' } : {}),
        ...(truthChanged ? { authorTruth: draft.authorTruth ?? '' } : {}),
        ...(statusChanged ? { status: draft.status as ForeshadowingStatusView } : {}),
        ...(changes.plantedAtChanged ? { plantedAt: changes.plantedAt } : {}),
        ...(changes.startChanged || changes.endChanged ? { payoffStart: changes.start, payoffEnd: changes.end } : {}),
        ...(changes.charactersChanged ? { relatedCharacters: changes.characters } : {}),
        ...(changes.entitiesChanged ? { relatedEntities: changes.entities } : {}),
        ...(changes.chaptersChanged ? { relatedChapters: changes.chapters } : {}),
        ...(changes.redHerringChanged ? { isRedHerring: changes.redHerring === true } : {}),
        ...(changes.resolvedAtChanged ? { resolvedAt: changes.resolvedAt === '' ? null : changes.resolvedAt } : {}),
        ...(options?.overwrite ? {} : { expectedContentHash: card.contentHash }),
      })
    },
    // 人工视角完整卡（磁盘基线 + 草稿覆盖），与 saveCard 同一比较口径；冲突字段
    // 比较与另存副本共用
    buildSnapshotCard: (card, draft) => {
      const changes = advancedChanges(card, draft)
      const name = draft.name !== null && draft.name.trim() !== card.name ? draft.name.trim() : null
      const reader = draft.readerView !== null && draft.readerView !== card.readerBody ? draft.readerView : null
      const truth = draft.authorTruth !== null && draft.authorTruth !== card.authorTruth ? draft.authorTruth : null
      return {
        ...card,
        ...(name !== null ? { name } : {}),
        ...(reader !== null ? { readerBody: reader } : {}),
        ...(truth !== null ? { authorTruth: truth } : {}),
        ...(draft.status != null && draft.status !== card.status ? { status: draft.status } : {}),
        ...(changes.plantedAtChanged ? { plantedAt: changes.plantedAt } : {}),
        ...(changes.startChanged || changes.endChanged
          ? {
              payoffStart: changes.start,
              payoffEnd: changes.end,
              payoffWindow: deriveLegacyPayoffWindow(changes.start, changes.end),
            }
          : {}),
        ...(changes.charactersChanged ? { relatedCharacters: changes.characters } : {}),
        ...(changes.entitiesChanged ? { relatedEntities: changes.entities } : {}),
        ...(changes.chaptersChanged ? { relatedChapters: changes.chapters } : {}),
        ...(changes.redHerringChanged ? { isRedHerring: changes.redHerring === true } : {}),
        ...(changes.resolvedAtChanged ? { resolvedAt: changes.resolvedAt === '' ? null : changes.resolvedAt } : {}),
      }
    },
    // 另存副本：完整卡按副本名新建（不覆盖原卡、不解冲突）——携带高级字段与
    // 计划窗口（计划 §七.10），窗口按有效值直接落结构化表达
    saveCopy: (projectId, card, name) => {
      const { start, end } = effectivePlannedWindow(card)
      return createForeshadowing(projectId, {
        name,
        readerView: card.readerBody,
        plantedAt: card.plantedAt,
        ...(card.authorTruth !== '' ? { authorTruth: card.authorTruth } : {}),
        payoffStart: start,
        payoffEnd: end,
        relatedCharacters: card.relatedCharacters,
        relatedEntities: card.relatedEntities,
        relatedChapters: card.relatedChapters,
        isRedHerring: card.isRedHerring,
      })
    },
    // 冲突字段比较：状态映射精确状态标签，两段正文按段落差异块展示，高级字段
    // 以展示文本并排（无差异字段的过滤在视图层）
    conflictFields: (mine, disk) => [
      { key: 'name', label: '伏笔名', mine: mine.name, disk: disk.name, kind: 'short' },
      { key: 'status', label: '状态', mine: FORESHADOWING_STATUS_LABELS[mine.status], disk: FORESHADOWING_STATUS_LABELS[disk.status], kind: 'short' },
      { key: 'readerBody', label: '读者视角', mine: mine.readerBody, disk: disk.readerBody, kind: 'long' },
      { key: 'authorTruth', label: '作者真相', mine: mine.authorTruth, disk: disk.authorTruth, kind: 'long' },
      { key: 'plantedAt', label: '埋设章节', mine: mine.plantedAt || '未填', disk: disk.plantedAt || '未填', kind: 'short' },
      {
        key: 'payoffWindow',
        label: '回收窗口',
        mine: plannedWindowDisplay(effectivePlannedWindow(mine).start, effectivePlannedWindow(mine).end),
        disk: plannedWindowDisplay(effectivePlannedWindow(disk).start, effectivePlannedWindow(disk).end),
        kind: 'short',
      },
      { key: 'relatedCharacters', label: '关联角色', mine: joinTagInput(mine.relatedCharacters) || '未填', disk: joinTagInput(disk.relatedCharacters) || '未填', kind: 'short' },
      { key: 'relatedEntities', label: '关联物品', mine: joinTagInput(mine.relatedEntities) || '未填', disk: joinTagInput(disk.relatedEntities) || '未填', kind: 'short' },
      { key: 'relatedChapters', label: '暗示历史', mine: joinTagInput(mine.relatedChapters) || '未填', disk: joinTagInput(disk.relatedChapters) || '未填', kind: 'short' },
      { key: 'isRedHerring', label: '红鲱鱼', mine: mine.isRedHerring ? '是（故意误导读者）' : '否', disk: disk.isRedHerring ? '是（故意误导读者）' : '否', kind: 'short' },
      { key: 'resolvedAt', label: '实际回收', mine: mine.resolvedAt || '未登记', disk: disk.resolvedAt || '未登记', kind: 'short' },
    ],
    moveCard: (projectId, id, status, afterId, beforeId) => updateForeshadowing(projectId, { id, status, afterId, beforeId }),
    // 确认放弃：以最新基线一次性提交「放弃状态 + 本次原因 + 拖入落点」；
    // 落点只在有意拖入时携带（详情内进入操作态不传，服务层按列尾落位），
    // 携带读取时 hash（外部修改冲突时确认冻结）
    confirmAbandonCard: (projectId, card, intent) => updateForeshadowing(projectId, {
      id: card.id,
      status: 'abandoned',
      abandonedReason: intent.reason,
      ...(intent.afterId !== null ? { afterId: intent.afterId } : {}),
      ...(intent.beforeId !== null ? { beforeId: intent.beforeId } : {}),
      expectedContentHash: card.contentHash,
    }),
    // 确认放弃原因修订（阶段 2）：只提交修订后的原因（状态不变），携带读取时
    // hash；已放弃状态下空原因由 core 层拒绝
    confirmReasonRevisionCard: (projectId, card, intent) => updateForeshadowing(projectId, {
      id: card.id,
      abandonedReason: intent.reason,
      expectedContentHash: card.contentHash,
    }),
    deleteCard: (projectId, id) => deleteForeshadowing(projectId, id),
    // 新建提交：窗口以结构化位置直接落新表达；起点未选而终点有值先补起点；
    // 终点单独留空 = 开放终点（计划 §三.1）
    submitCreate: (projectId, draft) => {
      const start = parsePlannedStart(draft.payoffStart.trim() || undefined)
      const end = parsePlannedPosition(draft.payoffEnd.trim() || undefined)
      if (start === null && end !== null) {
        throw new Error('回收窗口：请先选择起点，终点可留空表示开放终点')
      }
      return createForeshadowing(projectId, {
        name: draft.name.trim(),
        readerView: draft.readerView.trim(),
        plantedAt: draft.plantedAt.trim(),
        ...(draft.authorTruth.trim() !== '' ? { authorTruth: draft.authorTruth.trim() } : {}),
        ...(start !== null ? { payoffStart: start, payoffEnd: end ?? { kind: 'open' as const } } : {}),
      })
    },
    extractConflict: (error, card) =>
      error instanceof ForeshadowingConflictError
        ? { ...card, readerBody: error.currentCard.body, authorTruth: card.authorTruth }
        : null,
    draftDiffers,
    isEmptyDraft: (draft) =>
      draft.name === null
      && draft.readerView === null
      && draft.authorTruth === null
      && draft.status == null
      && draft.plantedAt == null
      && draft.payoffStart == null
      && draft.payoffEnd == null
      && draft.relatedCharactersText == null
      && draft.relatedEntitiesText == null
      && draft.relatedChapters == null
      && draft.isRedHerring == null
      && draft.resolvedAt == null,
    emptyDraft: () => ({ ...EMPTY_DRAFT }),
    cardTitle: (card) => card.name,
    hasCreateInput,
    // 只清与提交时一致的输入，保留创建期间继续键入的内容
    clearCreateDraft: (current, submitted) => ({
      name: current.name.trim() === submitted.name.trim() ? '' : current.name,
      readerView: current.readerView.trim() === submitted.readerView.trim() ? '' : current.readerView,
      authorTruth: current.authorTruth.trim() === submitted.authorTruth.trim() ? '' : current.authorTruth,
      plantedAt: current.plantedAt.trim() === submitted.plantedAt.trim() ? '' : current.plantedAt,
      payoffStart: current.payoffStart.trim() === submitted.payoffStart.trim() ? '' : current.payoffStart,
      payoffEnd: current.payoffEnd.trim() === submitted.payoffEnd.trim() ? '' : current.payoffEnd,
    }),
    emptyCreateDraft: () => ({
      name: '', readerView: '', authorTruth: '', plantedAt: '', payoffStart: '', payoffEnd: '',
    }),
    messages: {
      loadBoard: '读取伏笔账本失败',
      readCard: '读取伏笔失败',
      saveCard: '保存伏笔失败',
      create: '新建伏笔失败',
      move: '移动伏笔失败',
      delete: '删除伏笔失败',
    },
  })

  /* ---------- 伏笔领域派生与动作（草稿分字段更新） ---------- */

  /** 伏笔名草稿（详情头部输入框）；null = 无未保存修改 */
  const draftName = computed(() => core.draft.value?.name ?? null)
  /** 读者视角草稿；null = 无未保存修改 */
  const draftReaderView = computed(() => core.draft.value?.readerView ?? null)
  /** 作者真相草稿；null = 无未保存修改 */
  const draftAuthorTruth = computed(() => core.draft.value?.authorTruth ?? null)
  /** 待保存的普通状态（详情状态按钮的等待标记）；null = 无状态修改 */
  const draftStatus = computed(() => core.draft.value?.status ?? null)
  /** 高级信息草稿；null = 无未保存修改 */
  const draftPlantedAt = computed(() => core.draft.value?.plantedAt ?? null)
  const draftPayoffStart = computed(() => core.draft.value?.payoffStart ?? null)
  const draftPayoffEnd = computed(() => core.draft.value?.payoffEnd ?? null)
  const draftRelatedCharactersText = computed(() => core.draft.value?.relatedCharactersText ?? null)
  const draftRelatedEntitiesText = computed(() => core.draft.value?.relatedEntitiesText ?? null)
  const draftRelatedChapters = computed(() => core.draft.value?.relatedChapters ?? null)
  const draftIsRedHerring = computed(() => {
    const value = core.draft.value?.isRedHerring
    return value == null ? null : value === 1
  })
  const draftResolvedAt = computed(() => core.draft.value?.resolvedAt ?? null)
  /** 新建面板各输入 */
  const newCardName = computed(() => core.createDraft.value.name)
  const newCardReaderView = computed(() => core.createDraft.value.readerView)
  const newCardAuthorTruth = computed(() => core.createDraft.value.authorTruth)
  const newCardPlantedAt = computed(() => core.createDraft.value.plantedAt)
  const newCardPayoffStart = computed(() => core.createDraft.value.payoffStart)
  const newCardPayoffEnd = computed(() => core.createDraft.value.payoffEnd)

  /** 新建面板是否满足三个必填项（提交按钮可用口径） */
  const hasRequiredCreateInput = computed(() => hasCreateInput(core.createDraft.value))

  /* ---------- 回收窗口新旧不一致（计划 §八.1 三出口） ---------- */

  /** 当前打开卡片的窗口两套数据是否不一致（仅结构化存在时比较；旧卡恒 false） */
  const windowMismatch = computed(() => {
    const card = core.activeCard.value
    return card !== null && payoffWindowMismatch(card)
  })

  /** 结构化窗口与兼容窗口的并列展示文本 */
  const windowMismatchViews = computed(() => {
    const card = core.activeCard.value
    if (card === null) {
      return null
    }
    const { start, end } = effectivePlannedWindow(card)
    return {
      structured: plannedWindowDisplay(start, end),
      legacy: card.payoffWindow ? `${card.payoffWindow[0]} ~ ${card.payoffWindow[1]}` : '未设置',
    }
  })

  /**
   * 窗口不一致的明确出口（成功才改变有效结果）：采用结构化 = 按结构化值重写
   * 旧字段；采用兼容 = 把旧窗口解释为固定章号位置或开放终点并重写结构化值
   * （原相对位置记录不保留）；携带读取时 hash，冲突则冻结详情转既有冲突流程。
   * 字段未收口（clean 前）不执行。
   */
  async function adoptWindowResolution(projectId: string, mode: 'structured' | 'legacy'): Promise<boolean> {
    const card = core.activeCard.value
    if (card === null || core.savePhase.value !== 'clean') {
      return false
    }
    const { start, end } = mode === 'structured'
      ? effectivePlannedWindow(card)
      : derivePositionsFromLegacyWindow(card.payoffWindow ?? null)
    try {
      const updated = await updateForeshadowing(projectId, {
        id: card.id,
        payoffStart: start,
        payoffEnd: end,
        expectedContentHash: card.contentHash,
      })
      core.lastSavedCard.value = updated
      await core.refreshBoard(projectId)
      if (core.activeCard.value?.id === card.id) {
        await core.openCard(projectId, card.id)
      }
      return true
    } catch (error) {
      if (error instanceof ForeshadowingConflictError) {
        // 干净会话没有待处理人工状态，引擎不建冲突：重读磁盘展示最新两套数据，
        // 作者基于新现场重新选择出口（不自动挑选一套）
        await core.openCard(projectId, card.id)
        core.actionError.value = '回收窗口出口遇到外部修改，已刷新为最新内容，请重新选择。'
        return false
      }
      core.actionError.value = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function updateDraftName(name: string) {
    core.updateDraft({ name })
  }

  function updateDraftReaderView(readerView: string) {
    core.updateDraft({ readerView })
  }

  function updateDraftAuthorTruth(authorTruth: string) {
    core.updateDraft({ authorTruth })
  }

  /** 普通状态选择：只登记待保存状态，不立即移动；连续点击以最后一次为准 */
  function updateDraftStatus(status: ForeshadowingStatusView) {
    core.updateDraft({ status })
  }

  /** 埋设章节（选择器产出真实章节引用；兼容原文由面板原样传入） */
  function updateDraftPlantedAt(plantedAt: string) {
    core.updateDraft({ plantedAt })
  }

  /** 计划窗口起点编码；终点（开放终点为 'open'）。清空起点时终点一并清 */
  function updateDraftPayoffStart(payoffStart: string) {
    core.updateDraft(payoffStart === 'none'
      ? { payoffStart, payoffEnd: 'none' }
      : { payoffStart })
  }

  function updateDraftPayoffEnd(payoffEnd: string) {
    core.updateDraft({ payoffEnd })
  }

  function updateDraftRelatedCharactersText(relatedCharactersText: string) {
    core.updateDraft({ relatedCharactersText })
  }

  function updateDraftRelatedEntitiesText(relatedEntitiesText: string) {
    core.updateDraft({ relatedEntitiesText })
  }

  /** 关联章节整表替换（数组顺序即作者排列；镜像存换行连接文本） */
  function updateDraftRelatedChapters(chapters: string[]) {
    core.updateDraft({ relatedChapters: joinChapterList(chapters) })
  }

  function updateDraftIsRedHerring(isRedHerring: boolean) {
    core.updateDraft({ isRedHerring: isRedHerring ? 1 : 0 })
  }

  /** 实际回收章节引用；空串 = 清除事实记录 */
  function updateDraftResolvedAt(resolvedAt: string) {
    core.updateDraft({ resolvedAt })
  }

  /** 新建面板草稿输入（按字段更新） */
  function updateCreateDraft(partial: Partial<ForeshadowingCreateDraft>) {
    core.updateCreateDraft(partial)
  }

  return {
    ...core,
    draftName,
    draftReaderView,
    draftAuthorTruth,
    draftStatus,
    draftPlantedAt,
    draftPayoffStart,
    draftPayoffEnd,
    draftRelatedCharactersText,
    draftRelatedEntitiesText,
    draftRelatedChapters,
    draftIsRedHerring,
    draftResolvedAt,
    newCardName,
    newCardReaderView,
    newCardAuthorTruth,
    newCardPlantedAt,
    newCardPayoffStart,
    newCardPayoffEnd,
    hasRequiredCreateInput,
    windowMismatch,
    windowMismatchViews,
    adoptWindowResolution,
    updateDraftName,
    updateDraftReaderView,
    updateDraftAuthorTruth,
    updateDraftStatus,
    updateDraftPlantedAt,
    updateDraftPayoffStart,
    updateDraftPayoffEnd,
    updateDraftRelatedCharactersText,
    updateDraftRelatedEntitiesText,
    updateDraftRelatedChapters,
    updateDraftIsRedHerring,
    updateDraftResolvedAt,
    updateCreateDraft,
  }
})
