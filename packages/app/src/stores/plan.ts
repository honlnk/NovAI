import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createPlan,
  deletePlan,
  getPlanBoard,
  readPlan,
  replacePlanTitleLine,
  updatePlan,
} from '@novai/core/services/plan-service'
import type {
  PlanBoardView,
  PlanCardSummaryView,
  PlanCardView,
  PlanStatusView,
} from '@novai/core/services/types'
import { PlanConflictError } from '@novai/core/types/plans'
import { createCardBoardCore, type BoardLoadSource, type CardBoardEditSession } from './card-board'

/**
 * 创作计划板 store：手动面板的唯一数据入口（AI 工具走 core 层同一服务，写入后
 * 经 file-changed 事件触发看板刷新）。看板加载/编辑会话/保存/冲突/新建等通用
 * 机件在 stores/card-board.ts（创作心智模块施工计划 §10.5 上提泛化），本文件
 * 只声明计划领域差异：正文+计划名双字段草稿、计划名改写正文首行的保存组合、
 * 已搁置列筛选、新建面板的「计划名 + 正文」输入。
 */

/** 计划编辑草稿：null 字段 = 该字段未修改（正文与计划名各自独立成草稿） */
export type PlanDraft = {
  body: string | null
  title: string | null
}

/** 卡片级编辑会话（草稿字段平铺；类型别名保留给既有引用） */
export type PlanEditSession = CardBoardEditSession<PlanDraft, PlanCardView>

export type { BoardLoadSource }

/** 新建面板输入：计划名独立输入，创建时作为正文首个非空行 */
type PlanCreateDraft = { title: string; body: string }

function emptyDraft(): PlanDraft {
  return { body: null, title: null }
}

/** 草稿与卡片是否有实际差异（null = 未修改；计划名按 trim 后比较） */
function planDraftDiffers(card: PlanCardView, draft: PlanDraft): boolean {
  return (draft.body !== null && draft.body !== card.body)
    || (draft.title !== null && draft.title.trim() !== card.title)
}

export const usePlanStore = defineStore('plan', () => {
  const core = createCardBoardCore<
    PlanStatusView,
    PlanCardSummaryView,
    PlanBoardView,
    PlanCardView,
    PlanDraft,
    PlanCreateDraft
  >({
    loadBoard: (projectId) => getPlanBoard(projectId),
    readCard: (projectId, id) => readPlan(projectId, id),
    // 保存组合：计划名变化时按新名改写正文首个非空行（body 同传以 body 为准的
    // 组合责任在调用方，见 core plans/store.ts 注释），并携带读取时 hash。
    saveCard: (projectId, card, draft) => {
      const title = draft.title?.trim() ?? ''
      const bodyChanged = draft.body !== null && draft.body !== card.body
      const titleChanged = draft.title !== null && draft.title.trim() !== card.title
      const rawBody = bodyChanged ? (draft.body as string) : null
      const nextBody = rawBody !== null && titleChanged
        ? replacePlanTitleLine(rawBody, title)
        : rawBody ?? undefined
      return updatePlan(projectId, {
        id: card.id,
        ...(nextBody !== undefined ? { body: nextBody } : {}),
        ...(titleChanged ? { title } : {}),
        expectedContentHash: card.contentHash,
      })
    },
    moveCard: (projectId, id, status, afterId, beforeId) => updatePlan(projectId, { id, status, afterId, beforeId }),
    deleteCard: (projectId, id) => deletePlan(projectId, id),
    // 新建提交：计划名作为正文首个非空行，与正文合成完整内容
    submitCreate: (projectId, draft) => {
      const title = draft.title.trim()
      const body = draft.body.trim()
      const fullBody = title && body ? `${title}\n\n${body}` : (title || body)
      return createPlan(projectId, { body: fullBody })
    },
    extractConflict: (error, card) =>
      error instanceof PlanConflictError ? { ...card, body: error.currentCard.body } : null,
    draftDiffers: planDraftDiffers,
    isEmptyDraft: (draft) => draft.body === null && draft.title === null,
    emptyDraft,
    cardTitle: (card) => card.title,
    hasCreateInput: (draft) => draft.title.trim() !== '' || draft.body.trim() !== '',
    // 只清与提交时一致的输入，保留创建期间继续键入的内容
    clearCreateDraft: (current, submitted) => ({
      title: current.title.trim() === submitted.title.trim() ? '' : current.title,
      body: current.body.trim() === submitted.body.trim() ? '' : current.body,
    }),
    emptyCreateDraft: () => ({ title: '', body: '' }),
    messages: {
      loadBoard: '读取计划板失败',
      readCard: '读取计划失败',
      saveCard: '保存计划失败',
      create: '新建计划失败',
      move: '移动计划失败',
      delete: '删除计划失败',
    },
  })

  /* ---------- 计划领域状态与派生（通用机件之外的部分） ---------- */

  /** 已搁置筛选：默认只看四列常驻栏目，可单独查看已搁置 */
  const showOnHold = ref(false)

  /** 看板列展示口径：默认四常驻列；开筛选后只显示已搁置列 */
  const visibleColumns = computed(() => {
    if (!core.board.value) {
      return []
    }

    const entries = Object.entries(core.board.value.columns) as [PlanStatusView, PlanCardSummaryView[]][]
    return showOnHold.value
      ? entries.filter(([status]) => status === 'on-hold')
      : entries.filter(([status]) => status !== 'on-hold')
  })

  /** 正文草稿（详情 textarea 绑定值）；null = 无未保存修改 */
  const draftBody = computed(() => core.draft.value?.body ?? null)
  /** 计划名草稿（详情头部输入框绑定值）；null = 无未保存修改 */
  const draftTitle = computed(() => core.draft.value?.title ?? null)
  /** 新建计划名（独立输入；创建时作为正文首个非空行） */
  const newCardTitle = computed(() => core.createDraft.value.title)
  /** 新建正文（首个非空行之后的 Markdown 内容） */
  const newCardBody = computed(() => core.createDraft.value.body)

  /* ---------- 领域动作（草稿分字段更新 / 直接创建入口 / 组合 reset） ---------- */

  function updateDraft(body: string) {
    core.updateDraft({ body })
  }

  /** 计划名输入（详情头部独立输入框） */
  function updateDraftTitle(title: string) {
    core.updateDraft({ title })
  }

  /** 新建面板草稿输入 */
  function updateCreateDraft(title: string, body: string) {
    core.updateCreateDraft({ title, body })
  }

  /** 直接创建（默认收集箱列尾），创建后打开详情；失败返回 null（错误进 actionError） */
  function createCard(projectId: string, body: string, status?: PlanStatusView) {
    return core.createCardVia(projectId, () => createPlan(projectId, { body, status }))
  }

  /** 切项目/关项目时在通用清理之上重置已搁置筛选 */
  function reset() {
    core.reset()
    showOnHold.value = false
  }

  return {
    ...core,
    showOnHold,
    visibleColumns,
    draftBody,
    draftTitle,
    newCardTitle,
    newCardBody,
    updateDraft,
    updateDraftTitle,
    updateCreateDraft,
    createCard,
    reset,
  }
})
