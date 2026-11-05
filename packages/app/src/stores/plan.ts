import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createPlan,
  deletePlan,
  getPlanBoard,
  readPlan,
  updatePlan,
} from '@novai/core/services/plan-service'
import type {
  PlanBoardView,
  PlanCardSummaryView,
  PlanCardView,
  PlanStatusView,
} from '@novai/core/services/types'
import { PlanConflictError } from '@novai/core/types/plans'

/**
 * 创作计划板 store：手动面板的唯一数据入口（AI 工具走 core 层同一服务，写入后
 * 经 file-changed 事件触发看板刷新）。
 *
 * 状态归属：
 * - 看板数据（board/详情草稿）以项目文件为事实来源，切项目时整体清理；
 * - 界面状态（搁置筛选、选中卡片 id）属会话内偏好，切项目一并重置（本期不做跨设备同步）。
 *
 * 冲突规则（计划 §保存与冲突）：
 * - 用户正在编辑时不拿远端内容覆盖草稿；文件有新修改时置 conflict 标记，
 *   由用户选择「重新读取」或「保留草稿」；
 * - 保存时携带读取时 contentHash，文件已变则服务层抛 PlanConflictError，草稿保留。
 */

export const usePlanStore = defineStore('plan', () => {
  const board = ref<PlanBoardView | null>(null)
  const isLoading = ref(false)
  const errorMessage = ref('')

  /** 当前打开的详情卡片完整内容（含 contentHash） */
  const activeCard = ref<PlanCardView | null>(null)
  /** 详情编辑草稿（textarea 绑定值）；null = 无未保存修改 */
  const draftBody = ref<string | null>(null)
  /** 详情计划名草稿（输入框绑定值）；null = 无未保存修改 */
  const draftTitle = ref<string | null>(null)
  /** 保存中（禁用重复提交） */
  const isSaving = ref(false)
  /** 打开的卡片在编辑外被外部修改（AI/外部编辑器）：提示重新读取或保留草稿 */
  const conflictNotice = ref<{ currentCard: PlanCardView } | null>(null)
  /** 上一次操作的错误信息（保存失败保留草稿时展示） */
  const actionError = ref('')

  const selectedCardId = ref<string | null>(null)
  /** 已搁置筛选：默认只看四列常驻栏目，可单独查看已搁置 */
  const showOnHold = ref(false)

  /* ---------- 新建抽屉（顶部 / 空状态 / 侧栏三个入口共用） ---------- */

  /** 新建抽屉是否打开 */
  const isCreateOpen = ref(false)
  /** 新建计划名（独立输入；创建时作为正文首个非空行） */
  const newCardTitle = ref('')
  /** 新建正文（首个非空行之后的 Markdown 内容） */
  const newCardBody = ref('')
  /** 创建中（禁用重复提交） */
  const isCreating = ref(false)

  /** 新建抽屉是否有未提交内容（离开保护用） */
  const hasCreateDraft = computed(() => newCardTitle.value.trim() !== '' || newCardBody.value.trim() !== '')

  const totalCardCount = computed(() => {
    if (!board.value) {
      return 0
    }
    return (Object.values(board.value.columns) as PlanCardSummaryView[][])
      .reduce((total, cards) => total + cards.length, 0)
  })

  /** 看板列展示口径：默认四常驻列；开筛选后只显示已搁置列 */
  const visibleColumns = computed(() => {
    if (!board.value) {
      return []
    }

    const entries = Object.entries(board.value.columns) as [PlanStatusView, PlanCardSummaryView[]][]
    return showOnHold.value
      ? entries.filter(([status]) => status === 'on-hold')
      : entries.filter(([status]) => status !== 'on-hold')
  })

  const hasUnsavedChanges = computed(() =>
    activeCard.value !== null
    && (
      (draftBody.value !== null && draftBody.value !== activeCard.value.body)
      || (draftTitle.value !== null && draftTitle.value.trim() !== activeCard.value.title)
    ),
  )

  async function loadBoard(projectId: string) {
    isLoading.value = true
    errorMessage.value = ''

    try {
      board.value = await getPlanBoard(projectId)
    } catch (error) {
      errorMessage.value = toMessage(error, '读取计划板失败')
    } finally {
      isLoading.value = false
    }
  }

  async function refreshBoard(projectId: string) {
    await loadBoard(projectId)
  }

  /** 打开卡片详情（未保存草稿切换前由组件层先确认） */
  async function openCard(projectId: string, id: string) {
    actionError.value = ''
    conflictNotice.value = null

    try {
      const card = await readPlan(projectId, id)
      if (!card) {
        // 卡片刚被删除（外部或 AI）：清空详情并刷新看板
        await refreshBoard(projectId)
        activeCard.value = null
        draftBody.value = null
        selectedCardId.value = null
        return
      }

      activeCard.value = card
      draftBody.value = null
      draftTitle.value = null
      selectedCardId.value = card.id
    } catch (error) {
      actionError.value = toMessage(error, '读取计划失败')
    }
  }

  function closeCard() {
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    conflictNotice.value = null
    actionError.value = ''
    selectedCardId.value = null
  }

  function updateDraft(body: string) {
    draftBody.value = body
  }

  /** 计划名输入（详情头部独立输入框） */
  function updateDraftTitle(title: string) {
    draftTitle.value = title
  }

  /**
   * 保存详情（计划名 + 正文一次提交）。携带读取时 contentHash：文件被外部改过时
   * 服务层抛冲突，草稿保留并由 conflictNotice 提示（不覆盖别人，也不丢草稿）。
   * 名称变化时服务层同步重命名文件（计划-<原序号>-<清理后名称>-<原短标识>.md），
   * 视图层对比保存前后 sourcePath 决定是否刷新文件树。返回是否保存成功。
   */
  async function saveDraft(projectId: string) {
    const card = activeCard.value

    if (!card || isSaving.value) {
      return false
    }

    const bodyChanged = draftBody.value !== null && draftBody.value !== card.body
    const titleChanged = draftTitle.value !== null && draftTitle.value.trim() !== card.title
    if (!bodyChanged && !titleChanged) {
      return false
    }

    isSaving.value = true
    actionError.value = ''

    try {
      const title = draftTitle.value?.trim() ?? ''
      const saved = await updatePlan(projectId, {
        id: card.id,
        ...(bodyChanged ? { body: draftBody.value as string } : {}),
        // 改回原值不重发；清空名称则交给服务层拒绝（计划名不能为空）
        ...(titleChanged ? { title } : {}),
        expectedContentHash: card.contentHash,
      })

      activeCard.value = saved
      draftBody.value = null
      draftTitle.value = null
      await refreshBoard(projectId)
      return true
    } catch (error) {
      if (error instanceof PlanConflictError) {
        conflictNotice.value = { currentCard: { ...card, body: error.currentCard.body } }
      }
      actionError.value = toMessage(error, '保存计划失败')
      return false
    } finally {
      isSaving.value = false
    }
  }

  /** 冲突处理：丢弃草稿，重新读取文件当前内容 */
  async function reloadFromConflict(projectId: string) {
    if (!conflictNotice.value || !activeCard.value) {
      return
    }

    conflictNotice.value = null
    await openCard(projectId, activeCard.value.id)
  }

  /** 冲突处理：保留当前草稿继续编辑（下次保存仍会校验 hash） */
  function keepDraft() {
    conflictNotice.value = null
  }

  /**
   * 新建卡片：默认收集箱列尾，创建后打开详情供继续输入。
   * 返回新卡片（失败返回 null，错误进 actionError）。
   */
  async function createCard(projectId: string, body: string, status?: PlanStatusView) {
    actionError.value = ''

    try {
      const card = await createPlan(projectId, { body, status })
      await refreshBoard(projectId)
      await openCard(projectId, card.id)
      return card
    } catch (error) {
      actionError.value = toMessage(error, '新建计划失败')
      return null
    }
  }

  /** 打开新建抽屉（顶部 / 空状态 / 侧栏入口共用；已有详情时先关详情） */
  function openCreate() {
    closeCard()
    isCreateOpen.value = true
  }

  /** 关闭新建抽屉；discard=true 时丢弃未提交内容（用户已在离开确认中选择放弃） */
  function closeCreate(discard = false) {
    if (discard) {
      newCardTitle.value = ''
      newCardBody.value = ''
      actionError.value = ''
    }
    isCreateOpen.value = false
  }

  /** 新建抽屉草稿输入 */
  function updateCreateDraft(title: string, body: string) {
    newCardTitle.value = title
    newCardBody.value = body
  }

  /**
   * 从新建抽屉提交：计划名作为正文首个非空行。等待真实保存结果——
   * 成功才清空输入并关闭抽屉（转入详情预览）；失败保留全部输入与抽屉。
   */
  async function submitCreate(projectId: string) {
    if (isCreating.value) {
      return null
    }

    const title = newCardTitle.value.trim()
    const body = newCardBody.value.trim()
    if (!title && !body) {
      return null
    }

    isCreating.value = true
    actionError.value = ''

    try {
      const fullBody = title && body ? `${title}\n\n${body}` : (title || body)
      const card = await createPlan(projectId, { body: fullBody })
      await refreshBoard(projectId)

      newCardTitle.value = ''
      newCardBody.value = ''
      isCreateOpen.value = false

      await openCard(projectId, card.id)
      return card
    } catch (error) {
      actionError.value = toMessage(error, '新建计划失败')
      return null
    } finally {
      isCreating.value = false
    }
  }

  /**
   * 状态切换 / 拖拽排序的统一入口（立即保存）。afterId 为目标位置前一卡片。
   * 成功后按 ID 同步当前抽屉详情（状态高亮 + 最新 contentHash），
   * 不动正文草稿；异步期间用户已切到其他卡片时不回写旧详情。
   */
  async function moveCard(projectId: string, id: string, status: PlanStatusView, afterId: string | null) {
    actionError.value = ''

    try {
      const updated = await updatePlan(projectId, { id, status, afterId })
      if (activeCard.value?.id === id) {
        activeCard.value = updated
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      actionError.value = toMessage(error, '移动计划失败')
      await refreshBoard(projectId)
      return false
    }
  }

  async function removeCard(projectId: string, id: string) {
    actionError.value = ''

    try {
      await deletePlan(projectId, id)

      if (selectedCardId.value === id) {
        closeCard()
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      actionError.value = toMessage(error, '删除计划失败')
      return false
    }
  }

  /** 切换项目 / 关闭项目时清理上一个项目的全部界面状态 */
  function reset() {
    board.value = null
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    conflictNotice.value = null
    actionError.value = ''
    errorMessage.value = ''
    selectedCardId.value = null
    showOnHold.value = false
    isCreateOpen.value = false
    newCardTitle.value = ''
    newCardBody.value = ''
    isCreating.value = false
  }

  return {
    board,
    isLoading,
    errorMessage,
    activeCard,
    draftBody,
    draftTitle,
    isSaving,
    conflictNotice,
    actionError,
    selectedCardId,
    showOnHold,
    isCreateOpen,
    newCardTitle,
    newCardBody,
    isCreating,
    hasCreateDraft,
    totalCardCount,
    visibleColumns,
    hasUnsavedChanges,
    loadBoard,
    refreshBoard,
    openCard,
    closeCard,
    updateDraft,
    updateDraftTitle,
    saveDraft,
    reloadFromConflict,
    keepDraft,
    createCard,
    openCreate,
    closeCreate,
    updateCreateDraft,
    submitCreate,
    moveCard,
    removeCard,
    reset,
  }
})

function toMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
