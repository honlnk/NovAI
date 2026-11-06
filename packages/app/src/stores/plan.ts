import { computed, ref, watch } from 'vue'
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
import { shouldReturnToPreviewAfterSave, type DetailMode } from '../components/plan/detail-mode'

/**
 * 创作计划板 store：手动面板的唯一数据入口（AI 工具走 core 层同一服务，写入后
 * 经 file-changed 事件触发看板刷新）。
 *
 * 状态归属：
 * - 看板数据（board/详情草稿）以项目文件为事实来源，切项目时整体清理；
 * - 界面状态（搁置筛选、选中卡片 id）属会话内偏好，切项目一并重置（本期不做跨设备同步）。
 * - 卡片级编辑会话（布局统一计划 §5.3）：按卡片 id 暂存被切走卡片的正文/计划名草稿
 *   与视图态，重开同一卡片时恢复；缓存只保存界面草稿，不成为计划内容的第二存储。
 *
 * 冲突规则（计划 §保存与冲突）：
 * - 用户正在编辑时不拿远端内容覆盖草稿；文件有新修改时置 conflict 标记，
 *   由用户选择「重新读取」或「保留草稿」；
 * - 保存时携带读取时 contentHash，文件已变则服务层抛 PlanConflictError，草稿保留。
 * - 带草稿的卡片被切走期间文件被外部修改，重开时不覆盖草稿，转同一冲突流程
 *   （activeCard 保持草稿基线 hash，保存仍会命中服务层校验）。
 */

/** 卡片级编辑会话：某张卡片被切走时暂存的界面草稿与视图态 */
export type PlanEditSession = {
  /** 正文草稿；null = 无未保存修改 */
  body: string | null
  /** 计划名草稿；null = 无未保存修改 */
  title: string | null
  /** 切走时的视图态（重开恢复编辑模式，布局统一计划 §5.2） */
  mode: DetailMode
  /** 草稿所基于的读取时内容 hash：重开时与最新 hash 对比判断外部修改 */
  baseContentHash: string
}

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
  /** 详情视图态：默认预览，随卡片切换按编辑会话恢复 */
  const detailMode = ref<DetailMode>('preview')
  /** 卡片级编辑会话缓存（key = 卡片 id；随项目 reset 清理） */
  const editSessions = ref(new Map<string, PlanEditSession>())
  /** 保存中（禁用重复提交） */
  const isSaving = ref(false)
  /** 打开的卡片在编辑外被外部修改（AI/外部编辑器）：提示重新读取或保留草稿 */
  const conflictNotice = ref<{ currentCard: PlanCardView } | null>(null)
  /** 上一次操作的错误信息（保存失败保留草稿时展示） */
  const actionError = ref('')

  const selectedCardId = ref<string | null>(null)
  /** 已搁置筛选：默认只看四列常驻栏目，可单独查看已搁置 */
  const showOnHold = ref(false)

  /* ---------- 新建面板（看板右上 / 空状态入口共用，与详情互斥展示） ---------- */

  /** 新建面板是否打开 */
  const isCreateOpen = ref(false)
  /** 新建计划名（独立输入；创建时作为正文首个非空行） */
  const newCardTitle = ref('')
  /** 新建正文（首个非空行之后的 Markdown 内容） */
  const newCardBody = ref('')
  /** 创建中（禁用重复提交） */
  const isCreating = ref(false)

  /** 新建面板是否有未提交内容（草稿静默保留，供恢复显示用） */
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

  // 保存成功（保存中结束且未保存修改清零）自动回到预览态（§详情预览 5）；
  // 冲突 / 失败路径未保存修改仍为 true，不误触发
  watch([isSaving, hasUnsavedChanges], ([saving, unsaved], [prevSaving]) => {
    if (shouldReturnToPreviewAfterSave(prevSaving, saving, unsaved)) {
      detailMode.value = 'preview'
    }
  })

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

  /* ---------- 卡片级编辑会话（布局统一计划 §5.2/§5.3） ---------- */

  /** 把当前卡片的界面草稿暂存进会话缓存（切卡 / 开新建前调用；无卡片为空操作） */
  function stashEditSession() {
    const card = activeCard.value
    if (!card) {
      return
    }
    editSessions.value.set(card.id, {
      body: draftBody.value,
      title: draftTitle.value,
      mode: detailMode.value,
      baseContentHash: card.contentHash,
    })
  }

  /**
   * 恢复目标卡片的编辑会话。有草稿且文件已被外部修改时不覆盖草稿：
   * activeCard 保持草稿基线 hash（保存仍命中服务层冲突校验），并置冲突提示。
   */
  function restoreEditSession(card: PlanCardView) {
    const session = editSessions.value.get(card.id)
    if (!session) {
      draftBody.value = null
      draftTitle.value = null
      detailMode.value = 'preview'
      return
    }

    draftBody.value = session.body
    draftTitle.value = session.title
    detailMode.value = session.mode

    const hasDraft = (session.body !== null && session.body !== card.body)
      || (session.title !== null && session.title.trim() !== card.title)
    if (hasDraft && session.baseContentHash !== card.contentHash) {
      activeCard.value = { ...card, contentHash: session.baseContentHash }
      conflictNotice.value = { currentCard: card }
    }
  }

  /** 打开卡片详情：切走当前卡片前暂存草稿，新建面板让位（输入保留） */
  async function openCard(projectId: string, id: string) {
    actionError.value = ''
    conflictNotice.value = null
    stashEditSession()
    isCreateOpen.value = false

    try {
      const card = await readPlan(projectId, id)
      if (!card) {
        // 卡片刚被删除（外部或 AI）：清空详情与会话并刷新看板
        await refreshBoard(projectId)
        editSessions.value.delete(id)
        activeCard.value = null
        draftBody.value = null
        draftTitle.value = null
        detailMode.value = 'preview'
        selectedCardId.value = null
        return
      }

      activeCard.value = card
      restoreEditSession(card)
      selectedCardId.value = card.id
    } catch (error) {
      actionError.value = toMessage(error, '读取计划失败')
    }
  }

  /** 彻底关闭详情（删除卡片等清理路径）；面板收起这类纯可见性操作不走这里 */
  function closeCard() {
    const id = activeCard.value?.id
    if (id) {
      editSessions.value.delete(id)
    }
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    detailMode.value = 'preview'
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

  /** 详情视图切换（预览/编辑）；值随卡片进入编辑会话，切卡可恢复 */
  function setDetailMode(mode: DetailMode) {
    detailMode.value = mode
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
      // 保存成功清除该卡片的编辑会话（§5.5）：草稿已落盘，无可恢复内容
      editSessions.value.delete(saved.id)
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

  /** 冲突处理：丢弃草稿（含会话缓存），重新读取文件当前内容并回到预览 */
  async function reloadFromConflict(projectId: string) {
    if (!conflictNotice.value || !activeCard.value) {
      return
    }

    editSessions.value.delete(activeCard.value.id)
    draftBody.value = null
    draftTitle.value = null
    conflictNotice.value = null
    detailMode.value = 'preview'
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

  /** 打开新建面板（看板右上 / 空状态入口共用）：切换展示对象，不清当前卡片草稿 */
  function openCreate() {
    stashEditSession()
    isCreateOpen.value = true
  }

  /** 关闭新建面板；discard=true 时丢弃未提交内容 */
  function closeCreate(discard = false) {
    if (discard) {
      newCardTitle.value = ''
      newCardBody.value = ''
      actionError.value = ''
    }
    isCreateOpen.value = false
  }

  /** 新建面板草稿输入 */
  function updateCreateDraft(title: string, body: string) {
    newCardTitle.value = title
    newCardBody.value = body
  }

  /**
   * 从新建面板提交：计划名作为正文首个非空行。等待真实保存结果——
   * 成功才清空输入并关闭面板（转入详情预览）；失败保留全部输入与面板。
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
   * 成功后按 ID 同步当前详情（状态高亮 + 最新 contentHash），
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

      // 删除后清除该卡片的编辑会话（§5.5），删除当前打开的卡片时一并关闭详情
      editSessions.value.delete(id)
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

  /** 切换项目 / 关闭项目时清理上一个项目的全部界面状态（含编辑会话） */
  function reset() {
    board.value = null
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    detailMode.value = 'preview'
    editSessions.value.clear()
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
    detailMode,
    editSessions,
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
    setDetailMode,
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
