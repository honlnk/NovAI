import { computed, ref, shallowRef, watch } from 'vue'

import { isSameBoardOrder, moveCardInBoard, type BoardColumns } from '../components/card-board/board-reorder'
import { shouldReturnToPreviewAfterSave, type DetailMode } from '../components/plan/detail-mode'

/**
 * 看板卡片 store 的通用机件（创作心智模块施工计划 §10.5，自计划模块上提泛化）：
 * 生成代次守卫、串行看板加载队列（批次计数）、乐观移动与原地短路、卡片级编辑
 * 会话（草稿/视图态/冲突随卡片暂存恢复）、按草稿版本的保存合并、新建面板流程。
 * 计划（stores/plan.ts）与伏笔（stores/foreshadowing.ts）各自 defineStore 内调用
 * 本工厂，再叠加领域 computed 与动作——避免三份平行实现。
 *
 * 领域差异全部经由 config 注入：
 * - 服务适配器（loadBoard/readCard/saveCard/moveCard/deleteCard/submitCreate）：
 *   草稿到服务入参的组合（如计划名改写正文首行）在适配器内完成；
 * - 草稿形状：TDraft 字段可空（null = 该字段未修改），会话把草稿字段平铺在顶层；
 * - 冲突提取：服务层冲突错误 → 带最新内容的卡片（无冲突返回 null）。
 *
 * 状态归属与冲突规则沿用计划板的约定：看板数据以项目文件为事实来源，切项目整体
 * 清理；用户正在编辑时不拿远端内容覆盖草稿，保存携带读取时 contentHash 命中服务
 * 层校验；带草稿的卡片被切走期间文件被外部修改，重开时不覆盖草稿，转冲突流程。
 */

/** 看板读取来源：首载（骨架屏）、操作后/外部变更自动同步、左侧手动刷新 */
export type BoardLoadSource = 'initial' | 'auto' | 'manual'

/** 卡片级编辑会话：某张卡片被切走时暂存的界面草稿（字段平铺）与视图态 */
export type CardBoardEditSession<TDraft extends object, TCard> = TDraft & {
  /** 切走时的视图态（重开恢复编辑模式） */
  mode: DetailMode
  /** 草稿所基于的读取时内容 hash：重开时与最新 hash 对比判断外部修改 */
  baseContentHash: string
  /** 草稿版本：识别保存期间继续输入的新内容 */
  revision: number
  /** 离开保存失败的卡片后，错误仍属于这张卡，不串到其他卡片 */
  actionError?: string
  /** 冲突随会话保留；重新打开该卡时再提示 */
  conflictCard?: TCard
}

/** 各领域 store 注入的适配器与领域规则 */
export interface CardBoardConfig<
  TStatus extends string,
  TSummary extends { id: string; status: TStatus },
  TBoard extends { columns: BoardColumns<TStatus, TSummary> },
  TCard,
  TDraft extends object,
  TCreateDraft extends object,
> {
  loadBoard(projectId: string): Promise<TBoard>
  readCard(projectId: string, id: string): Promise<TCard | null>
  /** 保存草稿；需要携带 card.contentHash 做外部修改校验的组合在这里完成 */
  saveCard(projectId: string, card: TCard, draft: TDraft): Promise<TCard>
  moveCard(projectId: string, id: string, status: TStatus, afterId: string | null): Promise<TCard>
  deleteCard(projectId: string, id: string): Promise<unknown>
  /** 新建面板提交：草稿到创建入参的组合在这里完成 */
  submitCreate(projectId: string, draft: TCreateDraft): Promise<TCard>
  /** 服务层冲突错误 → 带最新内容的卡片；非冲突错误返回 null */
  extractConflict(error: unknown, card: TCard): TCard | null
  /** 草稿与卡片是否有实际差异（null 字段 = 未修改，不参与比较） */
  draftDiffers(card: TCard, draft: TDraft): boolean
  /** 全部字段为 null（无任何未保存修改）的草稿 */
  isEmptyDraft(draft: TDraft): boolean
  /** 全字段为 null 的草稿模板：字段首次被修改前 / 暂存无草稿会话时兜底 */
  emptyDraft(): TDraft
  /** 卡片展示名（离开卡片后的保存失败通知引用） */
  cardTitle(card: TCard): string
  /** 新建草稿是否有可提交内容 */
  hasCreateInput(draft: TCreateDraft): boolean
  /** 创建成功后只清已提交部分，保留随后追加的输入 */
  clearCreateDraft(current: TCreateDraft, submitted: TCreateDraft): TCreateDraft
  emptyCreateDraft(): TCreateDraft
  messages: {
    loadBoard: string
    readCard: string
    saveCard: string
    create: string
    move: string
    delete: string
  }
}

/** 卡片的最小约定：稳定 id + 读取时内容 hash（冲突流程的基线） */
export type CardBoardCard = { id: string; contentHash: string }

/**
 * 看板通用机件工厂。必须在 defineStore 的 setup 内调用（refs 归属单个 store 实例）。
 * 返回值直接 spread 进 store 返回对象；领域 computed/动作（如计划的搁置筛选）
 * 由各模块在其外叠加。
 */
export function createCardBoardCore<
  TStatus extends string,
  TSummary extends { id: string; status: TStatus },
  TBoard extends { columns: BoardColumns<TStatus, TSummary> },
  TCard extends CardBoardCard,
  TDraft extends object,
  TCreateDraft extends object,
>(config: CardBoardConfig<TStatus, TSummary, TBoard, TCard, TDraft, TCreateDraft>) {
  // 泛型容器一律 shallowRef：深层 ref 会把 TCard/TDraft 经 UnwrapRef 污染成
  // 无法证明相容的类型；这里的全部写入都是整体替换（无字段级突变），浅层即够，
  // 与原 plan store 对 savingSessions 的处理同理。
  const board = shallowRef<TBoard | null>(null)
  const isLoading = ref(false)
  const errorMessage = ref('')
  /** 后台同步提示来源（手动刷新文案区分「刷新」与「同步」）；首载不显示提示 */
  const boardSyncSource = ref<'auto' | 'manual'>('auto')
  /** 手动刷新成功序号：组件据此短暂显示「已更新」（自动同步成功不打扰） */
  const manualRefreshedCount = ref(0)

  /** 当前打开的详情卡片完整内容（含 contentHash） */
  const activeCard = shallowRef<TCard | null>(null)
  /** 详情编辑草稿（字段可空：null = 该字段未修改）；null 整体 = 无未保存修改 */
  const draft = shallowRef<TDraft | null>(null)
  /** 详情视图态：默认预览，随卡片切换按编辑会话恢复 */
  const detailMode = ref<DetailMode>('preview')
  /** 卡片级编辑会话缓存（key = 卡片 id；随项目 reset 清理；仅整体替换触发） */
  const editSessions = shallowRef(new Map<string, CardBoardEditSession<TDraft, TCard>>())
  /** 保存中（按当前卡片识别；Promise 不交给 Vue 深层代理） */
  const savingSessions = shallowRef(new Map<string, Promise<boolean>>())
  const isSaving = computed(() => activeCard.value !== null && savingSessions.value.has(activeCard.value.id))
  /** 保存成功仍按原卡片返回；视图刷新文件树不依赖保存结束时用户正看哪张卡 */
  const lastSavedCard = shallowRef<TCard | null>(null)
  /** 打开的卡片在编辑外被外部修改（AI/外部编辑器）：提示重新读取或保留草稿 */
  const conflictNotice = shallowRef<{ currentCard: TCard } | null>(null)
  /** 上一次操作的错误信息（保存失败保留草稿时展示） */
  const actionError = ref('')
  const detailError = ref<{ cardId: string; message: string } | null>(null)
  const detailNotice = ref<{ cardId: string; message: string } | null>(null)

  const selectedCardId = ref<string | null>(null)

  /* ---------- 新建面板（与详情互斥展示；草稿形状由领域注入） ---------- */

  const isCreateOpen = ref(false)
  const createDraft = shallowRef<TCreateDraft>(config.emptyCreateDraft())
  const isCreating = ref(false)
  /** 项目代次：reset 使所有在途操作失效，不能回写已关闭的项目 */
  let projectGeneration = 0
  let currentProjectId: string | null = null
  /** 读取序号：只有当前项目里最后一次选择的卡片可以接管详情 */
  let openSequence = 0
  /** 每份草稿有独立版本；保存只清理提交时那一版，保留随后继续输入的内容 */
  const draftVersions = new Map<string, number>()
  /** 新建只允许当前项目的最后一次提交回写新建草稿 */
  let createSequence = 0
  /** 创建是否已交由独立文件操作承接；界面取消不应让它保持提交锁 */
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
  const hasCreateDraft = computed(() => config.hasCreateInput(createDraft.value))

  const totalCardCount = computed(() => {
    if (!board.value) {
      return 0
    }
    return (Object.values(board.value.columns) as TSummary[][])
      .reduce((total, cards) => total + cards.length, 0)
  })

  const hasUnsavedChanges = computed(() =>
    activeCard.value !== null
    && draft.value !== null
    && config.draftDiffers(activeCard.value, draft.value),
  )

  // 保存成功（保存中结束且未保存修改清零）自动回到预览态；
  // 冲突 / 失败路径未保存修改仍为 true，不误触发
  watch([isSaving, hasUnsavedChanges], ([saving, unsaved], [prevSaving]) => {
    if (shouldReturnToPreviewAfterSave(prevSaving, saving, unsaved)) {
      detailMode.value = 'preview'
    }
  })

  /* ---------- 看板读取：首载骨架屏 + 后台刷新保留看板 ---------- */

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
      const result = await config.loadBoard(projectId)
      if (isCurrentProject(projectId, generation)) {
        board.value = result
        if (source === 'manual') {
          batchManualSucceeded = true
        }
      }
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        errorMessage.value = toMessage(error, config.messages.loadBoard)
      }
    }
  }

  /** 进入分类读取看板：无数据为首载（骨架屏），已有数据时等同后台同步 */
  async function loadBoard(projectId: string) {
    await enqueueBoardLoad(projectId, board.value === null ? 'initial' : 'auto')
  }

  /** 重新拉取看板：操作后自动同步与左侧手动刷新共用，source 决定顶部提示文案 */
  async function refreshBoard(projectId: string, options: { source?: 'auto' | 'manual' } = {}) {
    await enqueueBoardLoad(projectId, options.source ?? 'auto')
  }

  /* ---------- 卡片级编辑会话 ---------- */

  /** 把当前卡片的界面草稿暂存进会话缓存（切卡 / 开新建前调用；无卡片为空操作） */
  function stashEditSession() {
    const card = activeCard.value
    if (!card) {
      return
    }
    editSessions.value.set(card.id, {
      ...(draft.value ?? config.emptyDraft()),
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
  function restoreEditSession(card: TCard) {
    const session = editSessions.value.get(card.id)
    if (!session) {
      draft.value = null
      detailMode.value = 'preview'
      draftVersions.set(card.id, 0)
      return
    }
    draftVersions.set(card.id, session.revision)

    draft.value = config.isEmptyDraft(session) ? null : session
    detailMode.value = session.mode

    if (config.draftDiffers(card, session) && (session.baseContentHash !== card.contentHash || session.conflictCard)) {
      activeCard.value = { ...card, contentHash: session.baseContentHash } as TCard
      conflictNotice.value = { currentCard: session.conflictCard ?? card }
    }
  }

  /** 打开卡片详情：切走当前卡片前暂存草稿，新建面板让位（输入保留） */
  async function openCard(projectId: string, id: string): Promise<void> {
    const generation = beginProject(projectId)
    const sequence = ++openSequence
    const wasCreateOpen = isCreateOpen.value
    if (activeCard.value?.id !== id || wasCreateOpen || detailMode.value !== 'preview'
      || draft.value !== null || conflictNotice.value) {
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
      const card = await config.readCard(projectId, id)
      if (!isLatest()) return
      if (!card) {
        // 卡片刚被删除（外部或 AI）：清空详情与会话并刷新看板。
        editSessions.value.delete(id)
        draftVersions.delete(id)
        activeCard.value = null
        draft.value = null
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
          draft.value = config.isEmptyDraft(session) ? null : session
          detailMode.value = session.mode
          if (session.baseContentHash !== current.contentHash) {
            activeCard.value = { ...current, contentHash: session.baseContentHash } as TCard
          }
        }
      }
    } catch (error) {
      if (isLatest()) {
        detailError.value = { cardId: id, message: toMessage(error, config.messages.readCard) }
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
    draft.value = null
    detailMode.value = 'preview'
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    detailNotice.value = null
    selectedCardId.value = null
  }

  /** 草稿字段更新（未动过的字段保持 null；调用方按领域字段拼 partial） */
  function updateDraft(partial: Partial<TDraft>) {
    if (activeCard.value) nextDraftVersion(activeCard.value.id)
    // 首次修改从全 null 模板起步，保证 TDraft 字段齐全（draftDiffers 依赖字段存在）
    draft.value = { ...config.emptyDraft(), ...(draft.value ?? {}), ...partial }
  }

  /** 详情视图切换（预览/编辑）；值随卡片进入编辑会话，切卡可恢复 */
  function setDetailMode(mode: DetailMode) {
    detailMode.value = mode
  }

  /**
   * 保存详情草稿。携带读取时 contentHash：文件被外部改过时服务层抛冲突，
   * 草稿保留并由 conflictNotice 提示（不覆盖别人，也不丢草稿）。
   * 保存只认发起时的项目、卡片和草稿版本。文件写入不能因用户切卡而取消，
   * 但结果必须更新原卡片的会话，不能覆盖新选择；保存期间继续输入的新版本
   * 也不能清掉。返回是否保存成功。
   */
  async function saveDraft(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || savingSessions.value.has(card.id)) return false

    const cardId = card.id
    if (draft.value === null || !config.draftDiffers(card, draft.value)) return false

    const generation = beginProject(projectId)
    const revision = draftVersions.get(cardId) ?? 0
    const submittedDraft: TDraft = { ...(draft.value as TDraft) }
    const previousMode = detailMode.value

    actionError.value = ''
    lastSavedCard.value = null
    const saving = (async (): Promise<boolean> => {
      try {
        const saved = await config.saveCard(projectId, card, submittedDraft)
        if (!isCurrentProject(projectId, generation)) return false
        lastSavedCard.value = saved

        const savedId = saved.id
        const stillCurrent = activeCard.value?.id === savedId
        const currentRevision = draftVersions.get(savedId) ?? 0
        const session = editSessions.value.get(savedId)
        const unchanged = currentRevision === revision
        if (unchanged) {
          // 未再编辑：该版草稿已经落盘，当前详情和暂存会话都以新文件为准。
          editSessions.value.delete(savedId)
          if (stillCurrent) {
            activeCard.value = saved
            draft.value = null
            detailMode.value = shouldReturnToPreviewAfterSave(true, false, false) ? 'preview' : previousMode
          }
        } else {
          // 只刷新文件基线，保留后续输入；无未保存修改的编辑态会话也可直接清理。
          const nextSession: CardBoardEditSession<TDraft, TCard> = {
            ...((stillCurrent ? draft.value : session) ?? config.emptyDraft()),
            mode: stillCurrent ? detailMode.value : (session?.mode ?? previousMode),
            baseContentHash: saved.contentHash,
            revision: currentRevision,
          }
          if (config.draftDiffers(saved, nextSession)) {
            editSessions.value.set(savedId, nextSession)
          } else {
            editSessions.value.delete(savedId)
          }
          if (stillCurrent) activeCard.value = saved
        }
        await refreshBoard(projectId)
        return true
      } catch (error) {
        if (!isCurrentProject(projectId, generation)) return false

        const message = toMessage(error, config.messages.saveCard)
        const currentCard = config.extractConflict(error, card)
        if (activeCard.value?.id === cardId) {
          if (currentCard) conflictNotice.value = { currentCard }
          actionError.value = message
        } else {
          const session = editSessions.value.get(cardId)
          if (session) {
            editSessions.value.set(cardId, {
              ...session,
              actionError: message,
              conflictCard: currentCard ?? undefined,
            })
          }
          detailNotice.value = { cardId, message: `「${config.cardTitle(card)}」${message}` }
        }
        return false
      }
    })()

    const sessions = new Map(savingSessions.value)
    sessions.set(cardId, saving)
    savingSessions.value = sessions
    try {
      return await saving
    } finally {
      // reset 后旧保存的收尾不能删除新项目中同 ID 卡片的新保存。
      if (savingSessions.value.get(cardId) === saving) {
        const sessions = new Map(savingSessions.value)
        sessions.delete(cardId)
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
    draft.value = null
    conflictNotice.value = null
    actionError.value = ''
    detailNotice.value = null
    detailError.value = null
    detailMode.value = 'preview'
    try {
      const card = await config.readCard(projectId, cardId)
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
        detailError.value = { cardId, message: toMessage(error, config.messages.readCard) }
      }
    }
  }

  /** 冲突处理：保留当前草稿继续编辑（下次保存仍会校验 hash） */
  function keepDraft() {
    conflictNotice.value = null
  }

  /**
   * 直接创建并打开详情（不走新建面板的领域入口共用）：等待真实创建结果，
   * 成功后刷新看板并打开新卡片。返回新卡片（失败返回 null，错误进 actionError）。
   */
  async function createCardVia(projectId: string, create: () => Promise<TCard>): Promise<TCard | null> {
    const generation = beginProject(projectId)
    const sequence = ++createSequence
    actionError.value = ''

    try {
      const card = await create()
      if (!isCurrentProject(projectId, generation)) return card
      await refreshBoard(projectId)
      if (sequence === createSequence) {
        await openCard(projectId, card.id)
      }
      return card
    } catch (error) {
      if (isCurrentProject(projectId, generation) && sequence === createSequence) {
        actionError.value = toMessage(error, config.messages.create)
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
      createDraft.value = config.emptyCreateDraft()
      actionError.value = ''
    }
    isCreateOpen.value = false
    isCreating.value = false
    createDetached = true
  }

  /** 新建面板草稿更新（null 字段保持不变） */
  function updateCreateDraft(partial: Partial<TCreateDraft>) {
    createDraft.value = { ...createDraft.value, ...partial }
  }

  /**
   * 从新建面板提交。等待真实保存结果——成功才清空已提交输入并关闭面板
   * （转入详情预览）；失败保留全部输入与面板。
   */
  async function submitCreate(projectId: string): Promise<TCard | null> {
    if (isCreating.value) {
      return null
    }
    if (!config.hasCreateInput(createDraft.value)) {
      return null
    }

    isCreating.value = true
    createDetached = false
    const wasCreateOpen = isCreateOpen.value
    const generation = beginProject(projectId)
    const sequence = ++createSequence
    const submittedDraft: TCreateDraft = { ...createDraft.value }

    try {
      const card = await config.submitCreate(projectId, submittedDraft)
      if (!isCurrentProject(projectId, generation)) return card
      await refreshBoard(projectId)
      const current = isCurrentProject(projectId, generation)
        && sequence === createSequence
        && (!wasCreateOpen || isCreateOpen.value)
      if (current) {
        // 创建中若又输入了其他内容，只清已提交部分，保留随后追加的草稿。
        createDraft.value = config.clearCreateDraft(createDraft.value, submittedDraft)
        isCreateOpen.value = false
        await openCard(projectId, card.id)
      }
      return card
    } catch (error) {
      if (isCurrentProject(projectId, generation) && sequence === createSequence) {
        actionError.value = toMessage(error, config.messages.create)
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
   * （状态高亮 + 最新 contentHash），不动草稿；异步期间用户已切到其他
   * 卡片时不回写旧详情。
   */
  async function moveCard(projectId: string, id: string, status: TStatus, afterId: string | null) {
    const generation = beginProject(projectId)
    actionError.value = ''
    const previousBoard = board.value
    const nextBoard = previousBoard
      ? moveCardInBoard(previousBoard, id, status, afterId)
      : null
    if (nextBoard) {
      board.value = nextBoard
    }

    // 原地投放短路：本地重排真实生效且各列 id 序列未变——状态、前驱与实际
    // 顺序均未变化——不写盘、不全量刷新、也不报成功。重排未生效（卡片或
    // 锚点不在本地视图、看板陈旧）时不短路，维持原行为交服务层判定。
    if (
      previousBoard
      && nextBoard
      && nextBoard !== previousBoard
      && isSameBoardOrder(previousBoard, nextBoard)
    ) {
      return true
    }

    try {
      const updated = await config.moveCard(projectId, id, status, afterId)
      if (!isCurrentProject(projectId, generation)) return true
      if (activeCard.value?.id === id) {
        activeCard.value = updated
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        actionError.value = toMessage(error, config.messages.move)
        await refreshBoard(projectId)
      }
      return false
    }
  }

  async function removeCard(projectId: string, id: string) {
    const generation = beginProject(projectId)
    actionError.value = ''

    try {
      await config.deleteCard(projectId, id)
      if (!isCurrentProject(projectId, generation)) return true

      // 删除后清除该卡片的编辑会话，删除当前打开的卡片时一并关闭详情
      editSessions.value.delete(id)
      draftVersions.delete(id)
      if (selectedCardId.value === id) {
        closeCard()
      }
      await refreshBoard(projectId)
      return true
    } catch (error) {
      if (isCurrentProject(projectId, generation)) {
        actionError.value = toMessage(error, config.messages.delete)
      }
      return false
    }
  }

  /** 切换项目 / 关闭项目时清理全部通用状态（领域界面状态由各模块的 reset 叠加） */
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
    draft.value = null
    detailMode.value = 'preview'
    editSessions.value = new Map()
    draftVersions.clear()
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    detailNotice.value = null
    lastSavedCard.value = null
    errorMessage.value = ''
    selectedCardId.value = null
    isCreateOpen.value = false
    createDraft.value = config.emptyCreateDraft()
  }

  return {
    board,
    isLoading,
    errorMessage,
    boardSyncSource,
    manualRefreshedCount,
    activeCard,
    draft,
    detailMode,
    editSessions,
    isSaving,
    lastSavedCard,
    conflictNotice,
    actionError,
    detailError,
    detailNotice,
    selectedCardId,
    isCreateOpen,
    createDraft,
    isCreating,
    hasCreateDraft,
    totalCardCount,
    hasUnsavedChanges,
    loadBoard,
    refreshBoard,
    openCard,
    closeCard,
    updateDraft,
    setDetailMode,
    saveDraft,
    reloadFromConflict,
    keepDraft,
    createCardVia,
    openCreate,
    closeCreate,
    updateCreateDraft,
    submitCreate,
    moveCard,
    removeCard,
    reset,
  }
}

function toMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
