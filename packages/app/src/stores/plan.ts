import { computed, ref, shallowRef, watch } from 'vue'
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
import { moveCardInBoard } from '../components/plan/board-reorder'
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
  /** 草稿版本：识别保存期间继续输入的新内容 */
  revision: number
  /** 离开保存失败的卡片后，错误仍属于这张卡，不串到其他卡片 */
  actionError?: string
  /** 冲突随会话保留；重新打开该卡时再提示 */
  conflictCard?: PlanCardView
}

/** 看板读取来源：首载（骨架屏）、操作后/外部变更自动同步、左侧手动刷新 */
export type BoardLoadSource = 'initial' | 'auto' | 'manual'

export const usePlanStore = defineStore('plan', () => {
  const board = ref<PlanBoardView | null>(null)
  const isLoading = ref(false)
  const errorMessage = ref('')
  /** 后台同步提示来源（手动刷新文案区分「刷新」与「同步」）；首载不显示提示 */
  const boardSyncSource = ref<'auto' | 'manual'>('auto')
  /** 手动刷新成功序号：组件据此短暂显示「计划已更新」（自动同步成功不打扰） */
  const manualRefreshedCount = ref(0)

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
  /** 保存中（按当前卡片识别；Promise 不交给 Vue 深层代理） */
  const savingSessions = shallowRef(new Map<string, Promise<boolean>>())
  const isSaving = computed(() => activeCard.value !== null && savingSessions.value.has(activeCard.value.id))
  /** 保存成功仍按原卡片返回；视图刷新文件树不依赖保存结束时用户正看哪张卡 */
  const lastSavedCard = ref<PlanCardView | null>(null)
  /** 打开的卡片在编辑外被外部修改（AI/外部编辑器）：提示重新读取或保留草稿 */
  const conflictNotice = ref<{ currentCard: PlanCardView } | null>(null)
  /** 上一次操作的错误信息（保存失败保留草稿时展示） */
  const actionError = ref('')
  const detailError = ref<{ cardId: string; message: string } | null>(null)
  const detailNotice = ref<{ cardId: string; message: string } | null>(null)

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
  /** 项目代次：reset 使所有在途操作失效，不能回写已关闭的项目 */
  let projectGeneration = 0
  let currentProjectId: string | null = null
  /** 读取序号：只有当前项目里最后一次选择的卡片可以接管详情 */
  let openSequence = 0
  /** 每份草稿有独立版本；保存只清理提交时那一版，保留随后继续输入的内容 */
  const draftVersions = new Map<string, number>()
  /** 新建只允许当前项目的最后一次提交回写新建草稿 */
  let createSequence = 0  /** 创建是否已交由独立文件操作承接；界面取消不应让它保持提交锁 */
  let createDetached = false

  function beginProject(projectId: string): number {
    if (currentProjectId !== projectId) {
      currentProjectId = projectId
      projectGeneration += 1
    }
    return projectGeneration
  }

  function isCurrentProject(projectId: string, generation: number): boolean {
    return currentProjectId === projectId && projectGeneration === generation
  }

  function nextDraftVersion(cardId: string): number {
    const version = (draftVersions.get(cardId) ?? 0) + 1
    draftVersions.set(cardId, version)
    return version
  }

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

  /* ---------- 看板读取：首载骨架屏 + 后台刷新保留看板（加载反馈修复） ---------- */

  // 串行排队 + 批次计数：保存/拖动/手动刷新/外部变更连续触发时合并为一段
  // 同步状态，响应严格按请求顺序落 board（后发不覆盖先发的乱序结果）。
  // 每次读取再叠加项目代次守卫：切换项目后，旧项目的在途响应不能回写。
  let boardLoadQueue: Promise<void> = Promise.resolve()
  let pendingBoardLoads = 0
  let pendingManualLoads = 0
  let batchManualSucceeded = false

  function enqueueBoardLoad(projectId: string, source: BoardLoadSource) {
    const generation = beginProject(projectId)
    pendingBoardLoads += 1
    if (source === 'manual') {
      pendingManualLoads += 1
    }
    // 批次里只要含手动刷新，提示就按「刷新」口径显示（合并成一次反馈）
    boardSyncSource.value = pendingManualLoads > 0 ? 'manual' : (source === 'initial' ? boardSyncSource.value : source)
    isLoading.value = true

    const run = boardLoadQueue.then(() => performBoardLoad(projectId, generation, source))
    boardLoadQueue = run.catch(() => {})
    return run.finally(() => {
      pendingBoardLoads -= 1
      if (source === 'manual') {
        pendingManualLoads -= 1
      }
      // 项目已切换：忙碌态与提示交给新项目的批次收尾，旧批次不再回写
      if (!isCurrentProject(projectId, generation)) {
        return
      }
      if (pendingBoardLoads === 0) {
        isLoading.value = false
        // 批次全部结束才给「已更新」：期间还有同步在跑时不提前报完成
        if (batchManualSucceeded && !errorMessage.value) {
          manualRefreshedCount.value += 1
        }
        batchManualSucceeded = false
        boardSyncSource.value = 'auto'
      } else if (pendingManualLoads === 0) {
        boardSyncSource.value = 'auto'
      }
    })
  }

  async function performBoardLoad(projectId: string, generation: number, source: BoardLoadSource) {
    errorMessage.value = ''
    try {
      const result = await getPlanBoard(projectId)
      if (isCurrentProject(projectId, generation)) {
        board.value = result
        if (source === 'manual') {
          batchManualSucceeded = true
        }
      }
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        errorMessage.value = toMessage(error, '读取计划板失败')
      }
    }
  }

  /** 进入计划分类读取看板：无数据为首载（骨架屏），已有数据时等同后台同步 */
  async function loadBoard(projectId: string) {
    await enqueueBoardLoad(projectId, board.value === null ? 'initial' : 'auto')
  }

  /** 重新拉取看板：操作后自动同步与左侧手动刷新共用，source 决定顶部提示文案 */
  async function refreshBoard(projectId: string, options: { source?: 'auto' | 'manual' } = {}) {
    await enqueueBoardLoad(projectId, options.source ?? 'auto')
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
      revision: draftVersions.get(card.id) ?? 0,
      actionError: actionError.value || undefined,
      conflictCard: conflictNotice.value?.currentCard,
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
      draftVersions.set(card.id, 0)
      return
    }
    draftVersions.set(card.id, session.revision)

    draftBody.value = session.body
    draftTitle.value = session.title
    detailMode.value = session.mode

    const hasDraft = (session.body !== null && session.body !== card.body)
      || (session.title !== null && session.title.trim() !== card.title)
    if (hasDraft && (session.baseContentHash !== card.contentHash || session.conflictCard)) {
      activeCard.value = { ...card, contentHash: session.baseContentHash }
      conflictNotice.value = { currentCard: session.conflictCard ?? card }
    }
  }

  /** 打开卡片详情：切走当前卡片前暂存草稿，新建面板让位（输入保留） */
  async function openCard(projectId: string, id: string): Promise<void> {
    const generation = beginProject(projectId)
    const sequence = ++openSequence
    const wasCreateOpen = isCreateOpen.value
    if (activeCard.value?.id !== id || wasCreateOpen || detailMode.value !== 'preview'
      || draftBody.value !== null || draftTitle.value !== null || conflictNotice.value) {
      stashEditSession()
    }
    actionError.value = ''
    conflictNotice.value = null
    detailError.value = null
    detailNotice.value = null
    if (wasCreateOpen) createSequence += 1
    createDetached = true
    isCreating.value = false
    isCreateOpen.value = false
    const isLatest = () => isCurrentProject(projectId, generation) && sequence === openSequence

    try {
      const card = await readPlan(projectId, id)
      if (!isLatest()) return
      if (!card) {
        // 卡片刚被删除（外部或 AI）：清空详情与会话并刷新看板。
        editSessions.value.delete(id)
        draftVersions.delete(id)
        activeCard.value = null
        draftBody.value = null
        draftTitle.value = null
        detailMode.value = 'preview'
        selectedCardId.value = null
        await refreshBoard(projectId)
        return
      }

      activeCard.value = card
      restoreEditSession(card)
      selectedCardId.value = card.id
      actionError.value = editSessions.value.get(id)?.actionError ?? ''
      if (!conflictNotice.value) detailNotice.value = null
      const saving = savingSessions.value.get(id)
      if (saving) {
        // 保存已在进行中的同卡重读只更新文件基线，已提交的草稿版本不清空。
        await saving
        if (!isLatest() || activeCard.value?.id !== id) return
        const current = activeCard.value
        const session = editSessions.value.get(id)
        if (current && session) {
          draftBody.value = session.body
          draftTitle.value = session.title
          detailMode.value = session.mode
          if (session.baseContentHash !== current.contentHash) {
            activeCard.value = { ...current, contentHash: session.baseContentHash }
          }
        }
      }
    } catch (error) {
      if (isLatest()) {
        detailError.value = { cardId: id, message: toMessage(error, '读取计划失败') }
      }
    }
  }

  /** 彻底关闭详情（删除卡片等清理路径）；面板收起这类纯可见性操作不走这里 */
  function closeCard() {
    openSequence += 1
    const id = activeCard.value?.id
    if (id) {
      editSessions.value.delete(id)
      draftVersions.delete(id)
    }
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    detailMode.value = 'preview'
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    selectedCardId.value = null
  }

  function updateDraft(body: string) {
    if (activeCard.value) nextDraftVersion(activeCard.value.id)
    draftBody.value = body
  }

  /** 计划名输入（详情头部独立输入框） */
  function updateDraftTitle(title: string) {
    if (activeCard.value) nextDraftVersion(activeCard.value.id)
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
  /**
   * 保存只认发起时的项目、卡片和草稿版本。文件写入不能因用户切卡而取消，但结果
   * 必须更新原卡片的会话，不能覆盖新选择；保存期间继续输入的新版本也不能清掉。
   */
  async function saveDraft(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || savingSessions.value.has(card.id)) return false

    const bodyChanged = draftBody.value !== null && draftBody.value !== card.body
    const titleChanged = draftTitle.value !== null && draftTitle.value.trim() !== card.title
    if (!bodyChanged && !titleChanged) return false

    const generation = beginProject(projectId)
    const revision = draftVersions.get(card.id) ?? 0
    const submittedBody = draftBody.value
    const submittedTitle = draftTitle.value
    const previousMode = detailMode.value
    const title = submittedTitle?.trim() ?? ''
    const rawBody = bodyChanged ? (submittedBody as string) : null
    const nextBody = rawBody !== null && titleChanged
      ? replacePlanTitleLine(rawBody, title)
      : rawBody ?? undefined

    actionError.value = ''
    lastSavedCard.value = null
    const saving = (async (): Promise<boolean> => {
      try {
        const saved = await updatePlan(projectId, {
          id: card.id,
          ...(nextBody !== undefined ? { body: nextBody } : {}),
          ...(titleChanged ? { title } : {}),
          expectedContentHash: card.contentHash,
        })
        if (!isCurrentProject(projectId, generation)) return false
        lastSavedCard.value = saved

        const stillCurrent = activeCard.value?.id === card.id
        const currentRevision = draftVersions.get(card.id) ?? 0
        const session = editSessions.value.get(card.id)
        const unchanged = currentRevision === revision
        if (unchanged) {
          // 未再编辑：该版草稿已经落盘，当前详情和暂存会话都以新文件为准。
          editSessions.value.delete(card.id)
          if (stillCurrent) {
            activeCard.value = saved
            draftBody.value = null
            draftTitle.value = null
            detailMode.value = shouldReturnToPreviewAfterSave(true, false, false) ? 'preview' : previousMode
          }
        } else {
          // 只刷新文件基线，保留后续输入；无未保存修改的编辑态会话也可直接清理。
          const nextSession: PlanEditSession = {
            body: stillCurrent ? draftBody.value : (session?.body ?? null),
            title: stillCurrent ? draftTitle.value : (session?.title ?? null),
            mode: stillCurrent ? detailMode.value : (session?.mode ?? previousMode),
            baseContentHash: saved.contentHash,
            revision: currentRevision,
          }
          const hasDraft = (nextSession.body !== null && nextSession.body !== saved.body)
            || (nextSession.title !== null && nextSession.title.trim() !== saved.title)
          if (hasDraft) {
            editSessions.value.set(card.id, nextSession)
          } else {
            editSessions.value.delete(card.id)
          }
          if (stillCurrent) activeCard.value = saved
        }
        await refreshBoard(projectId)
        return true
      } catch (error) {
        if (!isCurrentProject(projectId, generation)) return false

        const message = toMessage(error, '保存计划失败')
        const currentCard = error instanceof PlanConflictError
          ? { ...card, body: error.currentCard.body }
          : undefined
        if (activeCard.value?.id === card.id) {
          if (currentCard) conflictNotice.value = { currentCard }
          actionError.value = message
        } else {
          const session = editSessions.value.get(card.id)
          if (session) {
            editSessions.value.set(card.id, { ...session, actionError: message, conflictCard: currentCard })
          }
          detailNotice.value = { cardId: card.id, message: `「${card.title}」${message}` }
        }
        return false
      }
    })()

    const sessions = new Map(savingSessions.value)
    sessions.set(card.id, saving)
    savingSessions.value = sessions
    try {
      return await saving
    } finally {
      // reset 后旧保存的收尾不能删除新项目中同 ID 卡片的新保存。
      if (savingSessions.value.get(card.id) === saving) {
        const sessions = new Map(savingSessions.value)
        sessions.delete(card.id)
        savingSessions.value = sessions
      }
    }
  }

  /** 冲突处理：丢弃草稿（含会话缓存），重新读取文件当前内容并回到预览 */
  async function reloadFromConflict(projectId: string) {
    if (!conflictNotice.value || !activeCard.value || savingSessions.value.has(activeCard.value.id)) return
    const generation = beginProject(projectId)
    const cardId = activeCard.value.id
    const sequence = ++openSequence

    editSessions.value.delete(cardId)
    draftVersions.set(cardId, (draftVersions.get(cardId) ?? 0) + 1)
    draftBody.value = null
    draftTitle.value = null
    conflictNotice.value = null
    actionError.value = ''
    detailNotice.value = null
    detailError.value = null
    detailMode.value = 'preview'
    try {
      const card = await readPlan(projectId, cardId)
      if (!isCurrentProject(projectId, generation) || sequence !== openSequence) return
      if (!card) {
        activeCard.value = null
        selectedCardId.value = null
        await refreshBoard(projectId)
        return
      }
      draftVersions.set(cardId, 0)
      activeCard.value = card
      selectedCardId.value = card.id
    } catch (error) {
      if (isCurrentProject(projectId, generation) && sequence === openSequence) {
        detailError.value = { cardId, message: toMessage(error, '读取计划失败') }
      }
    }
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
    const generation = beginProject(projectId)
    const sequence = ++createSequence
    actionError.value = ''

    try {
      const card = await createPlan(projectId, { body, status })
      if (!isCurrentProject(projectId, generation)) return card
      await refreshBoard(projectId)
      if (sequence === createSequence) {
        await openCard(projectId, card.id)
      }
      return card
    } catch (error) {
      if (isCurrentProject(projectId, generation) && sequence === createSequence) {
        actionError.value = toMessage(error, '新建计划失败')
      }
      return null
    }
  }

  /** 打开新建面板（看板右上 / 空状态入口共用）：切换展示对象，不清当前卡片草稿 */
  function openCreate() {
    if (isCreateOpen.value) return
    stashEditSession()
    isCreateOpen.value = true
  }

  /** 关闭新建面板；discard=true 时丢弃未提交内容 */
  function closeCreate(discard = false) {
    createSequence += 1
    if (discard) {
      newCardTitle.value = ''
      newCardBody.value = ''
      actionError.value = ''
    }
    isCreateOpen.value = false
    isCreating.value = false
    createDetached = true
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
    createDetached = false
    const wasCreateOpen = isCreateOpen.value
    const generation = beginProject(projectId)
    const sequence = ++createSequence
    const submittedTitle = title
    const submittedBody = body

    try {
      const fullBody = submittedTitle && submittedBody ? `${submittedTitle}\n\n${submittedBody}` : (submittedTitle || submittedBody)
      const card = await createPlan(projectId, { body: fullBody })
      if (!isCurrentProject(projectId, generation)) return card
      await refreshBoard(projectId)
      const current = isCurrentProject(projectId, generation)
        && sequence === createSequence
        && (!wasCreateOpen || isCreateOpen.value)
      if (current) {
        // 创建中若又输入了其他内容，只清已提交部分，保留随后追加的草稿。
        if (newCardTitle.value.trim() === submittedTitle) newCardTitle.value = ''
        if (newCardBody.value.trim() === submittedBody) newCardBody.value = ''
        isCreateOpen.value = false
        await openCard(projectId, card.id)
      }
      return card
    } catch (error) {
      if (isCurrentProject(projectId, generation) && sequence === createSequence) {
        actionError.value = toMessage(error, '新建计划失败')
      }
      return null
    } finally {
      if (isCurrentProject(projectId, generation) && (sequence === createSequence || createDetached)) {
        isCreating.value = false
        createDetached = false
      }
    }
  }

  /**
   * 状态切换 / 拖拽排序的统一入口（立即保存）。afterId 为目标位置前一卡片。
   * 松手后先把卡片本地移到目标位置（不等写盘与目录重扫），成功后刷新看板以
   * 文件系统为准；失败保留错误提示并刷新回真实状态。按 ID 同步当前详情
   * （状态高亮 + 最新 contentHash），不动正文草稿；异步期间用户已切到其他
   * 卡片时不回写旧详情。
   */
  async function moveCard(projectId: string, id: string, status: PlanStatusView, afterId: string | null) {
    const generation = beginProject(projectId)
    actionError.value = ''
    if (board.value) {
      board.value = moveCardInBoard(board.value, id, status, afterId)
    }

    try {
      const updated = await updatePlan(projectId, { id, status, afterId })
      if (!isCurrentProject(projectId, generation)) return true
      if (activeCard.value?.id === id) {
        activeCard.value = updated
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        actionError.value = toMessage(error, '移动计划失败')
        await refreshBoard(projectId)
      }
      return false
    }
  }

  async function removeCard(projectId: string, id: string) {
    const generation = beginProject(projectId)
    actionError.value = ''

    try {
      await deletePlan(projectId, id)
      if (!isCurrentProject(projectId, generation)) return true

      // 删除后清除该卡片的编辑会话（§5.5），删除当前打开的卡片时一并关闭详情
      editSessions.value.delete(id)
      draftVersions.delete(id)
      if (selectedCardId.value === id) {
        closeCard()
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        actionError.value = toMessage(error, '删除计划失败')
      }
      return false
    }
  }

  /** 切换项目 / 关闭项目时清理上一个项目的全部界面状态（含编辑会话） */
  function reset() {
    projectGeneration += 1
    currentProjectId = null
    openSequence += 1
    createSequence += 1
    savingSessions.value = new Map()
    isCreating.value = false
    createDetached = false
    board.value = null
    isLoading.value = false
    boardSyncSource.value = 'auto'
    activeCard.value = null
    draftBody.value = null
    draftTitle.value = null
    detailMode.value = 'preview'
    editSessions.value.clear()
    draftVersions.clear()
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    detailNotice.value = null
    lastSavedCard.value = null
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
    boardSyncSource,
    manualRefreshedCount,
    activeCard,
    draftBody,
    draftTitle,
    detailMode,
    editSessions,
    isSaving,
    lastSavedCard,
    conflictNotice,
    actionError,
    detailError,
    detailNotice,
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
