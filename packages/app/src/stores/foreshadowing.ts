import { computed } from 'vue'
import { defineStore } from 'pinia'

import {
  createForeshadowing,
  deleteForeshadowing,
  getForeshadowingBoard,
  readForeshadowing,
  updateForeshadowing,
} from '@novai/core/services/foreshadowing-service'
import type {
  ForeshadowingBoardView,
  ForeshadowingCardSummaryView,
  ForeshadowingCardView,
  ForeshadowingStatusView,
} from '@novai/core/services/types'
import { ForeshadowingConflictError } from '@novai/core/types/foreshadowing'
import { createCardBoardCore } from './card-board'

/**
 * 伏笔账本 store：与计划板同一套看板机件（stores/card-board.ts），只声明伏笔
 * 领域差异——「伏笔名 + 读者视角 + 作者真相」三字段草稿（保存时携带读取时
 * hash，改伏笔名同步重命名文件在 core 层完成）与新建面板的伏笔字段输入。
 *
 * UI 是作者本人的界面，作者真相直接可读可编辑（创作心智模块施工计划 §七）；
 * truth-hidden 防线只在 AI 工具链路（ReadForeshadowing 永不含真相）。
 */

/** 伏笔编辑草稿：null 字段 = 该字段未修改 */
export type ForeshadowingDraft = {
  name: string | null
  readerView: string | null
  authorTruth: string | null
  /** 待保存的普通状态（阶段 2：点击状态按钮只登记，两秒后随本卡整体保存；「已放弃」走原因确认流程，阶段 4 接入） */
  status: ForeshadowingStatusView | null
}

/** 新建面板输入：伏笔名/读者视角/埋设章节必填，作者真相与回收窗口可选 */
export type ForeshadowingCreateDraft = {
  name: string
  readerView: string
  authorTruth: string
  plantedAt: string
  payoffStart: string
  payoffEnd: string
}

const EMPTY_DRAFT: ForeshadowingDraft = { name: null, readerView: null, authorTruth: null, status: null }

/**
 * 草稿与卡片是否有实际差异（null = 未修改）。status 判定用宽松 null（!= null）：
 * 阶段 1 之前的镜像记录没有该字段，恢复路径读到 undefined 不算差异，避免旧记录
 * 恢复后被误判有修改而立即写盘。
 */
function draftDiffers(card: ForeshadowingCardView, draft: ForeshadowingDraft): boolean {
  return (draft.name !== null && draft.name.trim() !== card.name)
    || (draft.readerView !== null && draft.readerView !== card.readerBody)
    || (draft.authorTruth !== null && draft.authorTruth !== card.authorTruth)
    || (draft.status != null && draft.status !== card.status)
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
    // 保存组合：只提交有实际变化的字段，普通状态与内容同一次写入（阶段 2），
    // 携带读取时 hash（core 层校验外部修改）
    saveCard: (projectId, card, draft) => {
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
        expectedContentHash: card.contentHash,
      })
    },
    moveCard: (projectId, id, status, afterId, beforeId) => updateForeshadowing(projectId, { id, status, afterId, beforeId }),
    deleteCard: (projectId, id) => deleteForeshadowing(projectId, id),
    // 新建提交：可选字段只在有值时提交（回收窗口要求起止俱全才构成区间）
    submitCreate: (projectId, draft) => {
      const payoffStart = draft.payoffStart.trim()
      const payoffEnd = draft.payoffEnd.trim()
      return createForeshadowing(projectId, {
        name: draft.name.trim(),
        readerView: draft.readerView.trim(),
        plantedAt: draft.plantedAt.trim(),
        ...(draft.authorTruth.trim() !== '' ? { authorTruth: draft.authorTruth.trim() } : {}),
        ...(payoffStart !== '' && payoffEnd !== '' ? { payoffWindow: [payoffStart, payoffEnd] } : {}),
      })
    },
    extractConflict: (error, card) =>
      error instanceof ForeshadowingConflictError
        ? { ...card, readerBody: error.currentCard.body, authorTruth: card.authorTruth }
        : null,
    draftDiffers,
    isEmptyDraft: (draft) =>
      draft.name === null && draft.readerView === null && draft.authorTruth === null && draft.status == null,
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
  /** 新建面板各输入 */
  const newCardName = computed(() => core.createDraft.value.name)
  const newCardReaderView = computed(() => core.createDraft.value.readerView)
  const newCardAuthorTruth = computed(() => core.createDraft.value.authorTruth)
  const newCardPlantedAt = computed(() => core.createDraft.value.plantedAt)
  const newCardPayoffStart = computed(() => core.createDraft.value.payoffStart)
  const newCardPayoffEnd = computed(() => core.createDraft.value.payoffEnd)

  /** 新建面板是否满足三个必填项（提交按钮可用口径） */
  const hasRequiredCreateInput = computed(() => hasCreateInput(core.createDraft.value))

  function updateDraftName(name: string) {
    core.updateDraft({ name })
  }

  function updateDraftReaderView(readerView: string) {
    core.updateDraft({ readerView })
  }

  function updateDraftAuthorTruth(authorTruth: string) {
    core.updateDraft({ authorTruth })
  }

  /** 普通状态选择（阶段 2）：只登记待保存状态，不立即移动；连续点击以最后一次为准 */
  function updateDraftStatus(status: ForeshadowingStatusView) {
    core.updateDraft({ status })
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
    newCardName,
    newCardReaderView,
    newCardAuthorTruth,
    newCardPlantedAt,
    newCardPayoffStart,
    newCardPayoffEnd,
    hasRequiredCreateInput,
    updateDraftName,
    updateDraftReaderView,
    updateDraftAuthorTruth,
    updateDraftStatus,
    updateCreateDraft,
  }
})
