import { computed, ref, shallowRef, watch } from 'vue'

import { isSameBoardOrder, moveCardInBoard, type BoardColumns } from '../components/card-board/board-reorder'
import { type DetailMode } from '../components/layout/detail-mode'
import {
  createSaveSessionRealm,
  type SaveSessionBase,
  type SaveSessionRestoreReport,
  type SaveSessionSettledResult,
} from '../composables/save-session'
import {
  loadProjectCardBackups,
  removeCardBackup,
  scheduleCardBackup,
  type PersistedCardDraft,
} from '../composables/card-backup'

/**
 * 看板卡片 store 的通用机件（创作心智模块施工计划 §10.5，自计划模块上提泛化）：
 * 生成代次守卫、串行看板加载队列（批次计数）、乐观移动与原地短路、统一卡片
 * 保存会话（composables/save-session 引擎实例）、新建面板流程。计划
 * （stores/plan.ts）与伏笔（stores/foreshadowing.ts）各自 defineStore 内调用
 * 本工厂，再叠加领域 computed 与动作——避免三份平行实现。
 *
 * 领域差异全部经由 config 注入：
 * - 服务适配器（loadBoard/readCard/saveCard/moveCard/deleteCard/submitCreate）：
 *   草稿到服务入参的组合（如计划名改写正文首行）在适配器内完成；
 * - 草稿形状：TDraft 字段可空（null = 该字段未修改）；
 * - 冲突提取：服务层冲突错误 → 带最新内容的卡片（无冲突返回 null）。
 *
 * 状态归属与冲突规则沿用计划板的约定：看板数据以项目文件为事实来源，切项目整体
 * 清理；用户正在编辑时不拿远端内容覆盖草稿，保存携带读取时 contentHash 命中服务
 * 层校验；带草稿的卡片被切走期间文件被外部修改，重开时不覆盖草稿，转冲突流程。
 *
 * 编辑会话已迁入统一保存会话引擎（阶段 1）：会话常驻（不再随切卡暂存/恢复），
 * 字段草稿、编辑模式、在途保存、失败与冲突都挂在会话上；引擎负责同键串行写盘、
 * 快照固定与只承认本次快照、失败自动补试与恢复镜像核对。草稿「改回与磁盘一致」
 * 时收敛为全空模板，让 clean 状态可表示（会话隐藏、镜像清除）。
 */

/** 看板读取来源：首载（骨架屏）、操作后/外部变更自动同步、左侧手动刷新 */
export type BoardLoadSource = 'initial' | 'auto' | 'manual'

/**
 * 统一保存会话中的卡片编辑状态：引擎基础字段 + 卡片领域字段。
 * 草稿与磁盘卡片异构（draft 字段可空、null = 未修改），基线快照固定为全空模板，
 * 基线版本令牌用 contentHash。
 */
export type CardSaveSession<TDraft extends object, TCard> = SaveSessionBase & {
  cardId: string
  /** 字段草稿（null 字段 = 未修改；全空 = 无未保存修改） */
  draft: TDraft
  /** 草稿基线快照：恒为全空模板（clean 可表示） */
  baseDraft: TDraft
  /** 会话依据的磁盘卡片版本令牌（保存校验与外部修改判定） */
  baseContentHash?: string
  /** 保存时组合服务入参所依据的磁盘卡片（contentHash 取读取时值） */
  diskCard?: TCard
  /** 切走时的视图态（重开恢复编辑模式） */
  mode: DetailMode
  /** 离开保存失败的卡片后，错误仍属于这张卡，不串到其他卡片 */
  actionMessage?: string
  /**
   * 待确认的放弃操作态（阶段 4，伏笔域）：不进草稿快照、不触发自动保存；
   * 确认前只随会话与恢复镜像保留，绝不自动写盘。拖入已放弃列时携带暂存落点。
   */
  abandon?: CardAbandonIntent
  /**
   * 取消操作态时暂存的原因文本（仅内存，不进镜像）：再次进入操作态时回填，
   * 便于手滑取消后继续填写；确认成功或会话清除时随之作废。
   */
  lastAbandonReason?: string
  /**
   * 待确认的放弃原因修订操作态（作者字段控制权计划阶段 2，伏笔域）：已放弃卡
   * 的历史原因修订——不进草稿快照、不触发自动保存；确认前只随会话与恢复镜像
   * 保留，绝不自动写盘。
   */
  reasonRevision?: { reason: string }
  /** 取消修订操作态时暂存的原因文本（仅内存，不进镜像；再次进入时回填）。 */
  lastReasonRevision?: string
  /**
   * 待确认的作者校正操作态（作者字段控制权计划阶段 4，节奏域）：状态、偏差
   * 结论与说明的表单输入——不进草稿快照、不触发自动保存；应用是明确操作：
   * 点击时固定当时完整快照，把表单结论与同轮未落盘草稿合并为一次整体保存
   * （§五.2.2，区别于放弃操作态的「先收口再确认」）。
   */
  authorCorrection?: CardAuthorCorrectionIntent
  /** 取消校正操作态时暂存的表单（仅内存，不进镜像；再次进入时回填）。 */
  lastAuthorCorrection?: CardAuthorCorrectionIntent
  /** 待确认的恢复自动判定操作态（阶段 4，节奏域）：仅存在性即待确认。 */
  restoreAutoPending?: true
  /**
   * 跨列拖拽的暂存落点（阶段 5 §六，节奏域）：与作者校正操作态同生命周期——
   * 「应用校正」一次保存判定与落点；取消/切卡/冲突未决不执行移动。列由表单
   * 状态决定（拖入预选、可改），afterId/beforeId 只锚定目标列内的位置。
   */
  pendingPlacement?: CardPendingPlacement
  /**
   * 显式判定保存的待提交载荷（仅内存瞬态，绝不进镜像）：确认动作写入、保存
   * 适配层首次尝试即消费删除——自动补试与后续普通保存都不会再携带。
   */
  pendingJudgmentSave?: CardJudgmentOp
}

/** 作者校正表单（通用层形状不透明：status 由领域解释与校验）。 */
export type CardAuthorCorrectionIntent = {
  status: string
  deviationFlag: boolean
  deviationNote: string
}

/** 跨列拖拽的暂存落点（通用层形状不透明：status 列 key 由领域解释）。 */
export type CardPendingPlacement = {
  status: string
  afterId: string | null
  beforeId?: string | null
}

/** 显式判定保存载荷：作者校正或恢复自动（领域经 saveCard 的 judgmentOp 落盘）。 */
export type CardJudgmentOp =
  | { kind: 'authorCorrection'; status: string; deviationFlag: boolean; deviationNote: string }
  | { kind: 'restoreAuto' }

/** 放弃操作态载荷：原因文本 + 看板拖入已放弃列时的暂存落点（列内定位） */
export type CardAbandonIntent = {
  reason: string
  afterId: string | null
  beforeId: string | null
}

/** 卡片级编辑会话的兼容视图（领域字段平铺 + 视图态；由统一会话派生） */
export type CardBoardEditSession<TDraft extends object, TCard> = TDraft & {
  /** 切走时的视图态（重开恢复编辑模式） */
  mode: DetailMode
  /** 草稿所基于的读取时内容 hash：重开时与最新 hash 对比判断外部修改 */
  baseContentHash: string
  /** 兼容保留（旧会话的草稿版本号；统一会话由快照比较承担该职责） */
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
  /**
   * 保存草稿；需要携带 card.contentHash 做外部修改校验的组合在这里完成。
   * overwrite = 冲突出口「采用我的当前内容」的整份覆盖写入：不携带版本校验。
   * judgmentOp = 显式判定保存载荷（阶段 4 作者校正/恢复自动）：领域把它与
   * 草稿增量合并成一次 updateRhythm 提交（一次保存同时落字段与判定结论）。
   * placement = 跨列拖拽暂存落点（阶段 5 §六）：只在 judgmentOp 同在的显式
   * 保存里携带（应用校正一次保存判定与落点），普通自动保存绝不带。
   */
  saveCard(
    projectId: string,
    card: TCard,
    draft: TDraft,
    options?: { overwrite?: boolean; judgmentOp?: CardJudgmentOp; placement?: CardPendingPlacement },
  ): Promise<TCard>
  moveCard(projectId: string, id: string, status: TStatus, afterId: string | null, beforeId?: string | null): Promise<TCard>
  deleteCard(projectId: string, id: string): Promise<unknown>
  /** 新建面板提交：草稿到创建入参的组合在这里完成 */
  submitCreate(projectId: string, draft: TCreateDraft): Promise<TCard>
  /** 人工视角完整卡（磁盘基线 + 草稿覆盖）：冲突字段比较与另存副本共用 */
  buildSnapshotCard(card: TCard, draft: TDraft): TCard
  /** 用领域新建能力把完整卡按名称另存为副本（不覆盖原卡，不解决原冲突） */
  saveCopy(projectId: string, card: TCard, name: string): Promise<TCard>
  /**
   * 确认放弃（阶段 4，可选——伏笔域注入）：一次性原子提交「放弃状态 + 本次
   * 原因 + 拖入落点」，携带读取时 hash；不提供则该域不开放放弃操作态。
   */
  confirmAbandonCard?(projectId: string, card: TCard, intent: { reason: string; afterId: string | null; beforeId: string | null }): Promise<TCard>
  /**
   * 确认放弃原因修订（作者字段控制权计划阶段 2，可选——伏笔域注入）：以最新
   * 磁盘基线一次性提交修订后的原因，携带读取时 hash；不提供则该域不开放修订。
   */
  confirmReasonRevisionCard?(projectId: string, card: TCard, intent: { reason: string }): Promise<TCard>
  /**
   * 判定操作态（作者字段控制权计划阶段 4，可选——节奏域注入）：作者校正与
   * 恢复自动的入口门槛与表单默认值（按卡片当前有效结论回填）；不提供则该域
   * 不开放判定操作态。应用/确认的落盘不走这里——由 saveCard 的 judgmentOp
   * 与显式保存（requestExplicitSave）合并提交。
   */
  judgment?: {
    defaultCorrection(card: TCard): CardAuthorCorrectionIntent
  }
  /**
   * 冲突字段比较（阶段 3）：mine = 人工视角完整卡、disk = 磁盘最新卡，返回
   * 领域字段的展示文本（枚举映射中文标签）。无差异字段的过滤在视图层。
   */
  conflictFields(mine: TCard, disk: TCard): ReadonlyArray<CardConflictField>
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

/**
 * 卡片会话守护（阶段 3）：AI/外部删除或重命名了有待写内容的卡片文件时置入，
 * 禁止一切写入（自动保存与覆盖出口都被引擎拒绝），现场按会话保留，由用户在
 * 详情里选择「恢复为副本 / 放弃并关闭」。
 */
export type CardSessionGuard =
  | { kind: 'deleted'; trashPath?: string }
  | { kind: 'renamed'; toPath: string }

/** 冲突字段比较条目（阶段 3 展开比较区）：short = 单行并排，long = 段落差异块 */
export type CardConflictField = {
  key: string
  label: string
  mine: string
  disk: string
  kind: 'short' | 'long'
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
  // 无法证明相容的类型；这里的全部写入都是整体替换（无字段级突变），浅层即够。
  const board = shallowRef<TBoard | null>(null)
  const isLoading = ref(false)
  const errorMessage = ref('')
  /** 后台同步提示来源（手动刷新文案区分「刷新」与「同步」）；首载不显示提示 */
  const boardSyncSource = ref<'auto' | 'manual'>('auto')
  /** 手动刷新成功序号：组件据此短暂显示「已更新」（自动同步成功不打扰） */
  const manualRefreshedCount = ref(0)

  /** 当前打开的详情卡片完整内容（含 contentHash） */
  const activeCard = shallowRef<TCard | null>(null)
  /** 详情视图态：默认预览，随卡片切换按编辑会话恢复 */
  const detailMode = ref<DetailMode>('preview')
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

  /** 新建面板是否有未提交内容（草稿静默保留，供恢复显示用） */
  const hasCreateDraft = computed(() => config.hasCreateInput(createDraft.value))

  const totalCardCount = computed(() => {
    if (!board.value) {
      return 0
    }
    return (Object.values(board.value.columns) as TSummary[][])
      .reduce((total, cards) => total + cards.length, 0)
  })

  /* ---------- 统一卡片保存会话（阶段 1） ---------- */

  /** 手动保存的同步去重标记（项目 + 卡片复合键：保存排队到写盘开始的间隙内也不重复提交） */
  const manualSaveInFlight = new Set<string>()

  function manualSaveKey(projectId: string, cardId: string): string {
    return JSON.stringify([projectId, cardId])
  }

  function scheduleSessionMirror(session: CardSaveSession<TDraft, TCard>): void {
    scheduleCardBackup(session.projectId, session.cardId, {
      draft: session.draft as unknown as PersistedCardDraft,
      baseContentHash: session.baseContentHash,
      mode: session.mode,
      ...(session.abandon !== undefined ? { abandon: { ...session.abandon } } : {}),
      ...(session.reasonRevision !== undefined ? { reasonRevision: { ...session.reasonRevision } } : {}),
      ...(session.authorCorrection !== undefined ? { authorCorrection: { ...session.authorCorrection } } : {}),
      ...(session.restoreAutoPending !== undefined ? { restoreAutoPending: true } : {}),
      ...(session.pendingPlacement !== undefined ? { pendingPlacement: { ...session.pendingPlacement } } : {}),
    })
  }

  const cardRealm = createSaveSessionRealm<CardSaveSession<TDraft, TCard>, TDraft, TCard>({
    isSameSnapshot: isSameDraft,
    getSnapshot: (session) => session.draft,
    setSnapshot: (session, snapshot) => {
      session.draft = snapshot
    },
    getBaseSnapshot: (session) => session.baseDraft,
    setBaseSnapshot: (session, snapshot) => {
      session.baseDraft = snapshot
    },
    getBaseVersion: (session) => session.baseContentHash,
    setBaseVersion: (session, version) => {
      session.baseContentHash = version
    },
    captureInFlight: (session) => {
      // 新保存周期开始：旧失败信息不再属于这张卡的当前详情
      delete session.actionMessage
      return true
    },
    releaseInFlight: (session) => {
      session.inFlight = null
    },
    createSession: (projectId, cardId, seed) => ({
      projectId,
      cardId,
      draft: seed.snapshot,
      baseDraft: seed.baseSnapshot,
      ...(seed.baseVersion !== undefined ? { baseContentHash: seed.baseVersion } : {}),
      mode: 'preview',
      inFlight: null,
      restoredPending: false,
      restoredAcked: false,
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
    }),
    upsertSession: (session, data) => {
      session.draft = data.snapshot
      session.baseDraft = data.baseSnapshot
    },
    save: async (_projectId, _cardId, snapshot, ctx) => {
      const card = ctx.session.diskCard
      if (!card) {
        return { ok: false, conflict: false, message: '卡片会话缺少磁盘基线，请重新打开卡片' }
      }
      // 显式判定载荷一次性消费：只在首次尝试的保存里携带，自动补试与后续
      // 普通保存不再带（避免无载荷落盘字段造成「只改字段不落判定」的语义漂移）。
      // 跨列暂存落点同一时序：只在显式判定保存里随 judgmentOp 一起携带（阶段 5
      // §六「应用校正一次保存判定与落点」），普通两秒自动保存绝不动看板位置
      const judgmentOp = ctx.session.pendingJudgmentSave
      if (judgmentOp) {
        delete ctx.session.pendingJudgmentSave
      }
      const placement = judgmentOp ? ctx.session.pendingPlacement : undefined
      try {
        const saved = await config.saveCard(
          ctx.session.projectId,
          card,
          snapshot,
          {
            ...(ctx.force ? { overwrite: true } : {}),
            ...(judgmentOp ? { judgmentOp } : {}),
            ...(placement ? { placement } : {}),
          },
        )
        // 写盘成功即更新会话的磁盘基线（写盘期间继续输入的保存按新基线校验）
        ctx.session.diskCard = saved
        return { ok: true, disk: saved }
      } catch (error) {
        const currentCard = config.extractConflict(error, card)
        if (currentCard) {
          return {
            ok: false,
            conflict: true,
            message: toMessage(error, config.messages.saveCard),
            disk: currentCard,
          }
        }
        return { ok: false, conflict: false, message: toMessage(error, config.messages.saveCard) }
      }
    },
    probe: async (projectId, cardId) => {
      const card = await config.readCard(projectId, cardId)
      return card ? { kind: 'ok', disk: card } : { kind: 'missing' }
    },
    versionOf: (card) => card.contentHash,
    snapshotFromDisk: () => config.emptyDraft(),
    isBaselineIntact: (record, card) => record.baseVersion === card.contentHash,
    isSnapshotOnDisk: (record, card) => !config.draftDiffers(card, record.snapshot),
    scheduleMirror: (session) => {
      scheduleSessionMirror(session)
    },
    removeMirror: (projectId, cardId) => {
      // 引擎在会话 clean 时清镜像；待确认的操作态（放弃/原因修订/作者校正/
      // 恢复自动/跨列落点）必须跨刷新保留，有槽时改写为「保留槽的记录」而不是删除
      const session = cardRealm.getSession(projectId, cardId)
      if (session?.abandon || session?.reasonRevision || session?.authorCorrection
        || session?.restoreAutoPending || session?.pendingPlacement) {
        scheduleSessionMirror(session)
        return
      }
      removeCardBackup(projectId, cardId)
    },
    // 待确认的操作态（放弃/原因修订/作者校正/恢复自动/跨列落点）= 快照外的待处理
    // 人工状态：外部写盘作废其提交基线，干净会话也建冲突（不是静默重读），用户
    // 先处理版本关系再确认（阶段 4；作者字段控制权计划 §五.2.4、§六）
    hasPendingState: (session) => session.abandon !== undefined
      || session.reasonRevision !== undefined
      || session.authorCorrection !== undefined
      || session.restoreAutoPending !== undefined
      || session.pendingPlacement !== undefined,
    onSettled: (projectId, cardId, result) => handleSaveSettled(projectId, cardId, result),
  })

  /**
   * 每次写盘完成的回执：同步看板与详情。文件写入不因用户切卡而取消，但结果
   * 只更新原卡片的会话，不能覆盖新选择；旧项目的结果不回写新现场。
   */
  async function handleSaveSettled(
    projectId: string,
    cardId: string,
    result: SaveSessionSettledResult<TCard>,
  ): Promise<void> {
    if (currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, cardId)
    if (result.status === 'saved') {
      lastSavedCard.value = result.disk
      if (activeCard.value?.id === cardId) {
        activeCard.value = result.disk
        actionError.value = ''
        // 保存成功保持当前编辑态（视图切换由用户手动预览/编辑控制），不自动跳预览
      }
      await refreshBoard(projectId)
      return
    }
    if (session) {
      session.actionMessage = result.message
    }
    if (activeCard.value?.id === cardId) {
      if (result.status === 'conflict') {
        const conflictCard = session?.conflict?.disk as TCard | undefined
        if (conflictCard) conflictNotice.value = { currentCard: conflictCard }
      }
      actionError.value = result.message
    } else {
      const card = session?.diskCard
      detailNotice.value = {
        cardId,
        message: `「${card ? config.cardTitle(card) : cardId}」${result.message}`,
      }
    }
  }

  /** 详情编辑草稿（字段可空：null = 该字段未修改）；null 整体 = 无未保存修改 */
  const draft = computed<TDraft | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const session = cardRealm.getSession(currentProjectId, card.id)
    if (!session || config.isEmptyDraft(session.draft)) {
      return null
    }
    return session.draft
  })

  /** 保存中（按当前卡片识别） */
  const isSaving = computed(() => {
    const card = activeCard.value
    return card !== null
      && currentProjectId !== null
      && cardRealm.getSession(currentProjectId, card.id)?.inFlight != null
  })

  /**
   * 详情保存状态条（阶段 2 无保存心智）：已保存 / 等待保存 / 正在保存 / 保存失败 /
   * 保存冲突（与正文口径一致；普通成功不弹提示，状态区更新即可）。
   */
  const savePhase = computed<'clean' | 'pending' | 'saving' | 'failed' | 'conflict'>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return 'clean'
    }
    const session = cardRealm.getSession(currentProjectId, card.id)
    if (!session) {
      return 'clean'
    }
    if (session.inFlight != null) {
      return 'saving'
    }
    if (session.conflict) {
      return 'conflict'
    }
    if (session.failure) {
      return 'failed'
    }
    return config.isEmptyDraft(session.draft) ? 'clean' : 'pending'
  })

  /** 当前卡片的普通失败原因（状态条 hover / 辅助说明用；与 actionError 同源） */
  const saveFailureMessage = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    return cardRealm.getSession(currentProjectId, card.id)?.failure?.message ?? null
  })

  /**
   * 卡片级编辑会话兼容视图（key = 卡片 id）：从统一会话派生，clean 会话隐藏
   * （保存成功/关闭详情后不再出现在表里）。
   */
  const editSessions = computed(() => {
    const view = new Map<string, CardBoardEditSession<TDraft, TCard>>()
    if (currentProjectId == null) {
      return view
    }
    for (const session of cardRealm.listSessions(currentProjectId)) {
      if (
        config.isEmptyDraft(session.draft)
        && !session.conflict
        && !session.failure
        && !session.guard
        && !session.restoredPending
      ) {
        continue
      }
      const conflictCard = session.conflict?.disk as TCard | undefined
      view.set(session.cardId, {
        ...session.draft,
        mode: session.mode,
        baseContentHash: session.baseContentHash ?? '',
        revision: 0,
        ...(session.actionMessage !== undefined ? { actionError: session.actionMessage } : {}),
        ...(conflictCard !== undefined ? { conflictCard } : {}),
      })
    }
    return view
  })

  /** 状态条「重试」：手动重试当前卡片的失败写入（重新开启自动补试周期） */
  async function retrySave(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) return false
    const session = cardRealm.getSession(projectId, card.id)
    if (!session || session.inFlight != null || session.conflict) return false
    actionError.value = ''
    const result = await cardRealm.requestSave(projectId, card.id, { trigger: 'manual' })
    return result.status === 'saved'
  }

  /** 收口当前卡片（切卡 / 切预览 / 让位新建等时机）：立即保存待写内容（冲突/守护下跳过） */
  function flushCard(projectId: string): Promise<unknown> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return Promise.resolve()
    }
    return cardRealm.flushSession(projectId, card.id)
  }

  /** 收口项目内全部有待写内容的卡片会话（切分类 / 关面板 / 离开项目） */
  function flushAllCards(projectId: string): Promise<void> {
    return cardRealm.flushSessions(projectId)
  }

  /** 打开/关闭输入自动保存触发（生产由 ProjectView 挂接；测试默认关闭保持手动语义） */
  function setCardAutosaveEnabled(enabled: boolean): void {
    cardRealm.setAutosaveInputEnabled(enabled)
  }

  /** 页面隐藏/关闭前收口全部待写会话（与正文各会话独立挂接） */
  function setupCardSaveLifecycle(): () => void {
    return cardRealm.setupLifecycle()
  }

  /** 打开（或按需创建）卡片会话，磁盘基线取当前读取的卡片 */
  function ensureCardSession(projectId: string, card: TCard): CardSaveSession<TDraft, TCard> {
    const existing = cardRealm.getSession(projectId, card.id)
    if (existing) {
      return existing
    }
    const session = cardRealm.openSession(projectId, card.id, {
      snapshot: config.emptyDraft(),
      baseSnapshot: config.emptyDraft(),
      baseVersion: card.contentHash,
    })
    session.diskCard = card
    return session
  }

  /** 编辑模式写入会话；有草稿时同步镜像（重开恢复编辑态） */
  function syncModeToSession(mode: DetailMode): void {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return
    }
    const session = cardRealm.getSession(currentProjectId, card.id)
    if (!session) {
      return
    }
    session.mode = mode
    if (!config.isEmptyDraft(session.draft)) {
      scheduleSessionMirror(session)
    }
  }

  const hasUnsavedChanges = computed(() =>
    activeCard.value !== null
      && draft.value !== null
      && config.draftDiffers(activeCard.value, draft.value),
  )

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

  /**
   * 打开卡片详情：会话常驻（草稿/模式随卡保留）。有草稿且文件已被外部修改
   * （或冲突随会话保留）时不覆盖草稿——显示卡保持草稿基线 hash（保存仍命中
   * 服务层冲突校验），并置冲突提示。
   */
  async function openCard(projectId: string, id: string): Promise<void> {
    // 切卡收口（阶段 2）：旧卡片的待写内容立即保存，不等剩余去抖窗口；
    // 结果只作用于原会话与原看板（handleSaveSettled 按归属处理），不阻塞打开。
    const previousCard = activeCard.value
    if (previousCard && previousCard.id !== id && currentProjectId != null) {
      void cardRealm.flushSession(currentProjectId, previousCard.id)
      // 切卡收口副本受控状态：已结算的错误不带到下一张卡；在途操作留给晚到结果按发起卡结算
      clearSettledConflictCopyUi(currentProjectId, previousCard.id)
    }
    const generation = beginProject(projectId)
    const sequence = ++openSequence
    const wasCreateOpen = isCreateOpen.value
    // 重开同一张卡不回显上一次已结算的副本错误（在途操作保留，成功后由调用方收口）
    clearSettledConflictCopyUi(projectId, id)
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
        // 删除/重命名守护（阶段 3）：会话有未落盘内容且已被置入守护时不清理，
        // 现场按会话保留，由守护横幅给出「恢复为副本/放弃并关闭」的去向选择
        const guarded = cardRealm.getSession(projectId, id)
        if (guarded?.guard && guarded.diskCard) {
          activeCard.value = guarded.diskCard
          detailMode.value = guarded.mode
          selectedCardId.value = id
          actionError.value = guarded.actionMessage ?? ''
          return
        }
        // 卡片刚被删除（外部或 AI）：清空详情与会话并刷新看板。
        cardRealm.clearSession(projectId, id)
        activeCard.value = null
        detailMode.value = 'preview'
        selectedCardId.value = null
        await refreshBoard(projectId)
        return
      }

      const session = ensureCardSession(projectId, card)
      const hasLiveDraft = !config.isEmptyDraft(session.draft)
      const draftChangedOnDisk = hasLiveDraft && config.draftDiffers(card, session.draft)
      const baselineChanged = session.baseContentHash !== undefined
        && session.baseContentHash !== card.contentHash

      if (draftChangedOnDisk && (baselineChanged || session.conflict)) {
        // 不覆盖草稿：显示卡保持草稿基线 hash，冲突提示携带磁盘最新版本。
        const baselineCard = { ...card, contentHash: session.baseContentHash ?? card.contentHash } as TCard
        session.diskCard = baselineCard
        if (!session.conflict) {
          session.conflict = { generation: 1, probing: false, missing: false, expanded: false, disk: card }
        }
        activeCard.value = baselineCard
        conflictNotice.value = { currentCard: (session.conflict.disk as TCard) ?? card }
      } else {
        if (hasLiveDraft && !draftChangedOnDisk) {
          // 草稿内容已与磁盘一致（外部改成同值）：冗余草稿收敛清空
          cardRealm.setInput(projectId, id, config.emptyDraft())
        }
        session.diskCard = card
        session.baseContentHash = card.contentHash
        activeCard.value = card
      }
      selectedCardId.value = card.id
      detailMode.value = session.mode
      actionError.value = session.actionMessage ?? ''
      if (!conflictNotice.value) detailNotice.value = null

      if (session.inFlight != null) {
        // 保存已在进行中的同卡重读只等保存收口，已提交的草稿由保存结果承认。
        await cardRealm.settleSave(projectId, id)
        if (!isLatest() || activeCard.value?.id !== id) return
        const settled = cardRealm.getSession(projectId, id)
        if (settled?.diskCard) {
          activeCard.value = settled.diskCard
        }
        detailMode.value = settled?.mode ?? 'preview'
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
    if (id && currentProjectId != null) {
      cardRealm.clearSession(currentProjectId, id)
      invalidateConflictCopyUi(currentProjectId, id)
    }
    activeCard.value = null
    detailMode.value = 'preview'
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    detailNotice.value = null
    selectedCardId.value = null
  }

  /** 草稿字段更新（未动过的字段保持 null；调用方按领域字段拼 partial） */
  function updateDraft(partial: Partial<TDraft>) {
    const card = activeCard.value
    if (!card || currentProjectId == null) return
    const session = ensureCardSession(currentProjectId, card)
    // 首次修改从全 null 模板起步，保证 TDraft 字段齐全（draftDiffers 依赖字段存在）
    const merged = { ...config.emptyDraft(), ...session.draft, ...partial }
    // 改回与磁盘一致的值时收敛为全空模板：clean 状态可表示（会话隐藏、镜像清除）
    const next = config.draftDiffers(card, merged) ? merged : config.emptyDraft()
    cardRealm.setInput(currentProjectId, card.id, next)
  }

  /** 详情视图切换（预览/编辑）；值随卡片进入编辑会话，切卡可恢复。切回预览即收口 */
  function setDetailMode(mode: DetailMode) {
    detailMode.value = mode
    syncModeToSession(mode)
    if (mode === 'preview' && activeCard.value && currentProjectId != null) {
      void cardRealm.flushSession(currentProjectId, activeCard.value.id)
    }
  }

  /**
   * 保存详情草稿。携带读取时 contentHash：文件被外部改过时服务层抛冲突，
   * 草稿保留并由 conflictNotice 提示（不覆盖别人，也不丢草稿）。
   * 保存只认发起时的项目和卡片；写盘经统一会话串行编排，保存期间继续输入的
   * 新版本不能被清掉。返回是否保存成功。
   */
  async function saveDraft(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card) return false
    if (manualSaveInFlight.has(manualSaveKey(projectId, card.id))) return false
    const session = cardRealm.getSession(projectId, card.id)
    if (!session || session.inFlight != null) return false
    if (config.isEmptyDraft(session.draft) || !config.draftDiffers(card, session.draft)) return false

    beginProject(projectId)
    const generation = projectGeneration
    manualSaveInFlight.add(manualSaveKey(projectId, card.id))
    actionError.value = ''
    lastSavedCard.value = null
    try {
      // 快照在请求时固定（同 tick）：排队到写盘开始之间继续输入的内容保留为待写
      const submitted: TDraft = { ...session.draft }
      const result = await cardRealm.requestSave(projectId, card.id, {
        trigger: 'manual',
        snapshot: submitted,
      })
      // 返回值只认发起时的项目代次：写盘照常完成（文件写入不因切项目取消），
      // 但保存期间项目已切换时，结果不应用于当前视图，按失败口径返回。
      return result.status === 'saved' && isCurrentProject(projectId, generation)
    } finally {
      manualSaveInFlight.delete(manualSaveKey(projectId, card.id))
    }
  }

  /** 冲突处理：丢弃草稿（含会话缓存与恢复镜像），重新读取文件当前内容并回到预览 */
  /* ---------- 版本冲突出口（阶段 3：非阻塞状态条 + 主动展开比较 + 四出口） ---------- */

  /**
   * AI/外部修改了该卡片文件且会话有未落盘内容：冻结自动写入并读取外部版本建立
   * 冲突（变更链接入用）。返回值与正文域一致：conflict = 首次冲突、
   * conflict-refresh = 既有冲突刷新磁盘版本、clean = 会话干净可安全刷新看板、
   * none = 无会话或守护中。
   */
  function freezeForExternalChange(projectId: string, cardId: string) {
    return cardRealm.freezeForExternal(projectId, cardId)
  }

  /**
   * 该卡片是否有未落盘的草稿（变更链判定删除/重命名是否需要置守护；
   * 冲突中的会话也算有待处理的人工内容）。
   */
  function hasCardDraft(projectId: string, cardId: string): boolean {
    const session = cardRealm.getSession(projectId, cardId)
    if (!session) {
      return false
    }
    return !config.isEmptyDraft(session.draft) || session.conflict !== undefined
  }

  /** AI/外部删除或重命名了有待写内容的卡片文件：置入守护（禁止一切写入，现场保留） */
  function setCardGuard(projectId: string, cardId: string, guard: CardSessionGuard): void {
    const session = cardRealm.getSession(projectId, cardId)
    if (!session) {
      return
    }
    session.guard = guard
    session.updatedAt = new Date().toISOString()
  }

  /**
   * 冲突视图（阶段 3）：有冲突即返回（紧凑状态条与展开比较共用），
   * expanded = 用户已展开比较；diskCard = 磁盘最新卡（探测完成后）。
   */
  const conflictView = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const conflict = cardRealm.getSession(currentProjectId, card.id)?.conflict
    if (!conflict) {
      return null
    }
    return {
      probing: conflict.probing,
      missing: conflict.missing,
      ...(conflict.unreadable !== undefined ? { unreadable: conflict.unreadable } : {}),
      expanded: conflict.expanded,
      diskCard: (conflict.disk as TCard | undefined) ?? null,
    }
  })

  /**
   * 冲突字段比较（展开比较区渲染）：mine = 人工视角完整卡（磁盘基线 + 草稿
   * 覆盖），disk = 磁盘最新卡；探测未完成时无比较数据。
   */
  const conflictFields = computed<ReadonlyArray<CardConflictField>>(() => {
    const view = conflictView.value
    const card = activeCard.value
    if (!view?.diskCard || !card || currentProjectId == null) {
      return []
    }
    const session = cardRealm.getSession(currentProjectId, card.id)
    if (!session?.diskCard) {
      return []
    }
    return config.conflictFields(config.buildSnapshotCard(session.diskCard, session.draft), view.diskCard)
  })

  /** 冲突再入口（紧凑状态条「比较并处理」）：重新读取磁盘最新并展开比较 */
  function expandCardConflict(projectId: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    void cardRealm.expandConflict(projectId, card.id)
  }

  /** 返回继续编辑：收起比较，保留人工内容、待选择状态与冲突再入口 */
  function collapseCardConflict(): void {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return
    }
    cardRealm.collapseConflict(currentProjectId, card.id)
  }

  /**
   * 采用磁盘版本（二次确认在视图层）：引擎重新读取成功并清掉人工内容后才算
   * 解决；resolved 后重开该卡展示最新内容并刷新看板。probe-failed 保持展开态
   * 呈现最新探测结果；aborted（确认在途时用户离开）不动现场。
   */
  async function adoptDiskVersion(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return false
    }
    // 待确认的操作态（放弃/原因修订/作者校正/恢复自动/跨列落点）跨「采用磁盘」
    // 保留（计划 §四：任何采用磁盘都不能顺带清除人工输入）；引擎成功路径会清除
    // 会话，由下方重开回填
    const preservedAbandon = cardRealm.getSession(projectId, card.id)?.abandon
    const preservedReasonRevision = cardRealm.getSession(projectId, card.id)?.reasonRevision
    const preservedAuthorCorrection = cardRealm.getSession(projectId, card.id)?.authorCorrection
    const preservedRestoreAutoPending = cardRealm.getSession(projectId, card.id)?.restoreAutoPending
    const preservedPlacement = cardRealm.getSession(projectId, card.id)?.pendingPlacement
    const result = await cardRealm.adoptDisk(projectId, card.id)
    if (result !== 'resolved') {
      return false
    }
    conflictNotice.value = null
    actionError.value = ''
    await refreshBoard(projectId)
    if (activeCard.value?.id === card.id) {
      await openCard(projectId, card.id)
    }
    if (preservedAbandon || preservedReasonRevision || preservedAuthorCorrection
      || preservedRestoreAutoPending || preservedPlacement) {
      const session = cardRealm.getSession(projectId, card.id)
      if (session) {
        if (preservedAbandon) {
          session.abandon = { ...preservedAbandon }
        }
        if (preservedReasonRevision) {
          session.reasonRevision = { ...preservedReasonRevision }
        }
        if (preservedAuthorCorrection) {
          session.authorCorrection = { ...preservedAuthorCorrection }
        }
        if (preservedRestoreAutoPending) {
          session.restoreAutoPending = true
        }
        if (preservedPlacement) {
          session.pendingPlacement = { ...preservedPlacement }
        }
        session.updatedAt = new Date().toISOString()
        scheduleSessionMirror(session)
      }
    }
    return true
  }

  /**
   * 采用我的当前内容（二次确认在视图层）：用最新人工快照整份覆盖原卡。成功后
   * 冲突解除（仍有未落盘输入时冲突保留）、可见字段立即同步到新内容。
   */
  async function overwriteWithMine(projectId: string): Promise<{ ok: boolean; message?: string }> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return { ok: false, message: '卡片已不在当前现场' }
    }
    const result = await cardRealm.overwriteContent(projectId, card.id)
    if (!result.ok) {
      return result
    }
    const settled = cardRealm.getSession(projectId, card.id)
    if (settled?.diskCard) {
      lastSavedCard.value = settled.diskCard
      if (activeCard.value?.id === card.id) {
        activeCard.value = settled.diskCard
      }
    }
    conflictNotice.value = null
    actionError.value = ''
    await refreshBoard(projectId)
    return { ok: true }
  }

  /**
   * 将人工视角完整卡另存为副本（领域新建能力）：不覆盖原卡、不解决原冲突。
   * 守护态的「恢复为副本」走 restoreConflictCopy，成功后清理发起卡的守护会话。
   *
   * 进行中与失败原因按「项目 + 卡片」隔离（受控副本状态）：冲突比较区的
   * 「另存为新卡片」与守护横幅的「恢复为新卡片」共用——发起卡进行中禁止重复
   * 提交；失败保持表单与名称（调用方据错误展示），成功由调用方收口。晚到结果
   * 只结算到发起卡：切卡后不把 busy/错误/收口动作应用到当前看到的其他卡片。
   */
  type ConflictCopyUiState = { busy: boolean; error: string }

  const conflictCopyStates = shallowRef<Record<string, ConflictCopyUiState>>({})
  /** 在途操作代次：关卡/切换清理后，晚到结果不得重新写入界面状态 */
  const conflictCopyTokens = new Map<string, number>()
  let conflictCopyTokenSeed = 0

  function conflictCopyKey(projectId: string, cardId: string): string {
    return JSON.stringify([projectId, cardId])
  }

  function readConflictCopyUi(projectId: string, cardId: string): ConflictCopyUiState | null {
    return conflictCopyStates.value[conflictCopyKey(projectId, cardId)] ?? null
  }

  function writeConflictCopyUi(projectId: string, cardId: string, state: ConflictCopyUiState): void {
    const key = conflictCopyKey(projectId, cardId)
    conflictCopyStates.value = { ...conflictCopyStates.value, [key]: state }
  }

  /** 清理已结算的副本状态（重开卡片不回显旧错误）；在途操作保留给晚到结果结算 */
  function clearSettledConflictCopyUi(projectId: string, cardId: string): void {
    const key = conflictCopyKey(projectId, cardId)
    if (conflictCopyStates.value[key]?.busy) {
      return
    }
    conflictCopyTokens.delete(key)
    if (conflictCopyStates.value[key] === undefined) {
      return
    }
    const next = { ...conflictCopyStates.value }
    delete next[key]
    conflictCopyStates.value = next
  }

  /** 作废副本状态（含在途）：关卡/清理会话后晚到结果不得重新回显 */
  function invalidateConflictCopyUi(projectId: string, cardId: string): void {
    const key = conflictCopyKey(projectId, cardId)
    conflictCopyTokens.delete(key)
    if (conflictCopyStates.value[key] === undefined) {
      return
    }
    const next = { ...conflictCopyStates.value }
    delete next[key]
    conflictCopyStates.value = next
  }

  /** 当前卡片的副本状态（视图只看到自己的操作；其他卡的在途/错误不串台） */
  const conflictCopyBusy = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return false
    }
    return readConflictCopyUi(currentProjectId, card.id)?.busy ?? false
  })

  const conflictCopyError = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return ''
    }
    return readConflictCopyUi(currentProjectId, card.id)?.error ?? ''
  })

  async function saveConflictCopy(projectId: string, name: string): Promise<TCard | null> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return null
    }
    if (readConflictCopyUi(projectId, card.id)?.busy) {
      return null
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.diskCard) {
      return null
    }
    const key = conflictCopyKey(projectId, card.id)
    const token = ++conflictCopyTokenSeed
    conflictCopyTokens.set(key, token)
    actionError.value = ''
    writeConflictCopyUi(projectId, card.id, { busy: true, error: '' })
    let failureMessage: string | null = null
    try {
      const merged = config.buildSnapshotCard(session.diskCard, session.draft)
      const copy = await config.saveCopy(projectId, merged, name)
      await refreshBoard(projectId)
      return copy
    } catch (error) {
      failureMessage = toMessage(error, config.messages.create)
      // 全局 actionError 只跟随发起卡：晚到失败不写到用户已切到的其他卡片
      if (currentProjectId === projectId && activeCard.value?.id === card.id) {
        actionError.value = failureMessage
      }
      return null
    } finally {
      if (conflictCopyTokens.get(key) === token) {
        conflictCopyTokens.delete(key)
        writeConflictCopyUi(projectId, card.id, {
          busy: false,
          error: failureMessage ?? '',
        })
      }
    }
  }

  /**
   * 守护出口「恢复为新卡片」：创建与清理都绑定发起卡——创建在途时用户切到
   * 其他卡片，成功后只清发起卡的守护会话，不关闭/清理当前查看的新卡片。
   */
  async function restoreConflictCopy(projectId: string, name: string): Promise<TCard | null> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return null
    }
    const originCardId = card.id
    const copy = await saveConflictCopy(projectId, name)
    if (!copy) {
      return null
    }
    discardGuardedSession(projectId, originCardId)
    return copy
  }

  /** 守护态视图：当前卡片会话的删除/重命名守护信息（横幅与出口展示用） */
  const guardNotice = computed<CardSessionGuard | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    return (cardRealm.getSession(currentProjectId, card.id)?.guard as CardSessionGuard | undefined) ?? null
  })

  /**
   * 守护出口「放弃并关闭」（阶段 3）：丢弃保留的未落盘现场并关闭详情。
   * 「恢复为副本」走 restoreConflictCopy：成功后带发起卡 id 走这里——用户
   * 已切到其他卡片时只清发起卡的守护会话，不关闭当前查看的卡片详情。
   */
  function discardGuardedSession(projectId: string, cardId?: string): void {
    if (currentProjectId !== projectId) {
      return
    }
    const targetCardId = cardId ?? activeCard.value?.id
    if (!targetCardId) {
      return
    }
    cardRealm.clearSession(projectId, targetCardId)
    invalidateConflictCopyUi(projectId, targetCardId)
    if (activeCard.value?.id !== targetCardId) {
      // 目标不是当前卡：只清发起卡现场（恢复镜像等随 clearSession 收口），
      // 当前卡详情、草稿与各类提示一律不动
      void refreshBoard(projectId)
      return
    }
    activeCard.value = null
    detailMode.value = 'preview'
    selectedCardId.value = null
    actionError.value = ''
    conflictNotice.value = null
    detailError.value = null
    detailNotice.value = null
    void refreshBoard(projectId)
  }

  /* ---------- 放弃操作态（阶段 4：伏笔域） ---------- */

  /** 当前打开卡片的待确认放弃操作态（原因输入绑定；null = 不在操作态） */
  const abandonIntent = computed<{ reason: string } | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const abandon = cardRealm.getSession(currentProjectId, card.id)?.abandon
    return abandon ? { reason: abandon.reason } : null
  })

  /** 确认放弃可点：操作态中、字段收口完成（clean）、领域钩子已注入 */
  const canConfirmAbandon = computed(() =>
    abandonIntent.value !== null
    && savePhase.value === 'clean'
    && config.confirmAbandonCard !== undefined,
  )

  /** 确认放弃进行中（按钮禁用与重复提交防护） */
  const isConfirmingAbandon = ref(false)

  /**
   * 进入放弃操作态：不登记状态、不产生两秒计时器；若此刻有字段修改或写盘
   * 在途先请求收口（操作区立即显示，「确认放弃」等 clean 后才可点）。
   * drop = 看板拖入已放弃列的暂存落点（确认时随放弃一起落盘）。
   */
  function startAbandon(projectId: string, drop?: { afterId: string | null; beforeId?: string | null }): boolean {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.confirmAbandonCard === undefined) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session) {
      return false
    }
    if (!session.abandon) {
      session.abandon = {
        reason: session.lastAbandonReason ?? '',
        afterId: drop?.afterId ?? null,
        beforeId: drop?.beforeId ?? null,
      }
      session.updatedAt = new Date().toISOString()
      scheduleSessionMirror(session)
    }
    // 已有字段修改/写盘在途：先收口（确认按钮由 savePhase 派生等待 clean）
    if (savePhase.value !== 'clean') {
      void cardRealm.flushSession(projectId, card.id)
    }
    return true
  }

  /** 放弃原因输入（只更新操作态，不触发自动保存） */
  function updateAbandonReason(projectId: string, reason: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.abandon) {
      return
    }
    session.abandon.reason = reason
    session.updatedAt = new Date().toISOString()
    scheduleSessionMirror(session)
  }

  /** 取消放弃：退出原因填写态，回到先前编辑现场；原因与编辑内容都不动 */
  function cancelAbandon(projectId: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.abandon) {
      return
    }
    // 已填原因暂存在会话内存里：再次进入操作态时回填，便于继续填写
    session.lastAbandonReason = session.abandon.reason
    delete session.abandon
    session.updatedAt = new Date().toISOString()
    if (config.isEmptyDraft(session.draft) && session.reasonRevision === undefined
      && session.authorCorrection === undefined && session.restoreAutoPending === undefined
      && session.pendingPlacement === undefined) {
      // 草稿与其他操作态也都干净：取消后不再需要恢复镜像
      removeCardBackup(projectId, card.id)
    } else {
      scheduleSessionMirror(session)
    }
  }

  /**
   * 确认放弃（二次入口在领域 UI）：以最新磁盘基线一次性提交「放弃状态 + 本次
   * 原因 + 拖入落点」，不等待两秒。成功后状态与原因立即生效、看板进放弃分组；
   * 失败或冲突时原状态不动、原因输入保留（冲突会冻结确认，待版本出口处理）。
   */
  async function confirmAbandonCard(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || !config.confirmAbandonCard || isConfirmingAbandon.value) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    const intent = session?.abandon
    if (!session || !intent || !session.diskCard || savePhase.value !== 'clean') {
      return false
    }
    const reason = intent.reason.trim()
    if (!reason) {
      return false
    }
    isConfirmingAbandon.value = true
    actionError.value = ''
    try {
      const updated = await config.confirmAbandonCard(projectId, session.diskCard, {
        reason,
        afterId: intent.afterId,
        beforeId: intent.beforeId,
      })
      // 成功：操作态与草稿收口（归属核对——晚到结果不覆盖用户已切到的新现场）
      delete session.abandon
      delete session.lastAbandonReason
      session.diskCard = updated
      session.baseContentHash = updated.contentHash
      session.draft = config.emptyDraft()
      session.baseDraft = config.emptyDraft()
      removeCardBackup(projectId, card.id)
      lastSavedCard.value = updated
      if (currentProjectId === projectId) {
        if (activeCard.value?.id === card.id) {
          activeCard.value = updated
          detailMode.value = 'preview'
          session.mode = 'preview'
        }
        await refreshBoard(projectId)
      }
      return true
    } catch (error) {
      // 失败：原状态不动、原因与操作态保留；外部修改冲突则建立冲突（确认随之冻结）
      const conflictCard = config.extractConflict(error, session.diskCard)
      if (conflictCard) {
        await cardRealm.freezeForExternal(projectId, card.id)
      }
      actionError.value = toMessage(error, config.messages.saveCard)
      return false
    } finally {
      isConfirmingAbandon.value = false
    }
  }

  /* ---------- 放弃原因修订操作态（作者字段控制权计划阶段 2：伏笔域） ---------- */

  /** 当前打开卡片的待确认原因修订操作态（null = 不在操作态） */
  const reasonRevisionIntent = computed<{ reason: string } | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const revision = cardRealm.getSession(currentProjectId, card.id)?.reasonRevision
    return revision ? { reason: revision.reason } : null
  })

  /** 应用修订可点：操作态中、字段收口完成（clean）、领域钩子已注入 */
  const canConfirmReasonRevision = computed(() =>
    reasonRevisionIntent.value !== null
    && savePhase.value === 'clean'
    && config.confirmReasonRevisionCard !== undefined,
  )

  /** 应用修订进行中（按钮禁用与重复提交防护） */
  const isConfirmingReasonRevision = ref(false)

  /**
   * 进入原因修订操作态：不登记草稿、不产生两秒计时器；若此刻有字段修改或写盘
   * 在途先请求收口（「应用修订」等 clean 后才可点）。回填上次取消时的暂存文本。
   */
  function startReasonRevision(projectId: string): boolean {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.confirmReasonRevisionCard === undefined) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session) {
      return false
    }
    if (!session.reasonRevision) {
      session.reasonRevision = { reason: session.lastReasonRevision ?? '' }
      session.updatedAt = new Date().toISOString()
      scheduleSessionMirror(session)
    }
    if (savePhase.value !== 'clean') {
      void cardRealm.flushSession(projectId, card.id)
    }
    return true
  }

  /** 修订原因输入（只更新操作态，不触发自动保存） */
  function updateReasonRevision(projectId: string, reason: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.reasonRevision) {
      return
    }
    session.reasonRevision.reason = reason
    session.updatedAt = new Date().toISOString()
    scheduleSessionMirror(session)
  }

  /** 取消修订：退出输入态，回到先前编辑现场；已填文本暂存（再次进入回填） */
  function cancelReasonRevision(projectId: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.reasonRevision) {
      return
    }
    session.lastReasonRevision = session.reasonRevision.reason
    delete session.reasonRevision
    session.updatedAt = new Date().toISOString()
    if (config.isEmptyDraft(session.draft) && session.abandon === undefined
      && session.authorCorrection === undefined && session.restoreAutoPending === undefined
      && session.pendingPlacement === undefined) {
      removeCardBackup(projectId, card.id)
    } else {
      scheduleSessionMirror(session)
    }
  }

  /**
   * 应用修订（领域 UI 的明确操作）：以最新磁盘基线一次性提交修订后的原因，
   * 不等待两秒。成功后原因立即生效；失败或冲突时原原因不动、输入保留（冲突
   * 会冻结应用，待版本出口处理）。已放弃状态下空原因由领域服务拒绝。
   */
  async function confirmReasonRevision(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || !config.confirmReasonRevisionCard || isConfirmingReasonRevision.value) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    const intent = session?.reasonRevision
    if (!session || !intent || !session.diskCard || savePhase.value !== 'clean') {
      return false
    }
    const reason = intent.reason.trim()
    if (!reason) {
      return false
    }
    isConfirmingReasonRevision.value = true
    actionError.value = ''
    try {
      const updated = await config.confirmReasonRevisionCard(projectId, session.diskCard, { reason })
      // 成功：只收口操作态与修订基线，不动其余草稿（clean 下草稿本就为空）
      delete session.reasonRevision
      delete session.lastReasonRevision
      session.diskCard = updated
      session.baseContentHash = updated.contentHash
      if (config.isEmptyDraft(session.draft) && session.abandon === undefined) {
        removeCardBackup(projectId, card.id)
      } else {
        scheduleSessionMirror(session)
      }
      lastSavedCard.value = updated
      if (currentProjectId === projectId) {
        if (activeCard.value?.id === card.id) {
          activeCard.value = updated
        }
        await refreshBoard(projectId)
      }
      return true
    } catch (error) {
      // 失败：原原因不动、输入与操作态保留；外部修改冲突则建立冲突（应用随之冻结）
      const conflictCard = config.extractConflict(error, session.diskCard)
      if (conflictCard) {
        await cardRealm.freezeForExternal(projectId, card.id)
      }
      actionError.value = toMessage(error, config.messages.saveCard)
      return false
    } finally {
      isConfirmingReasonRevision.value = false
    }
  }

  /* ---------- 判定操作态（作者字段控制权计划阶段 4：节奏域） ---------- */

  /** 当前打开卡片的待确认作者校正操作态（null = 不在操作态） */
  const authorCorrectionIntent = computed<CardAuthorCorrectionIntent | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const intent = cardRealm.getSession(currentProjectId, card.id)?.authorCorrection
    return intent ? { ...intent } : null
  })

  /** 当前打开卡片是否处于待确认的恢复自动判定（两步确认的第二步） */
  const isRestoreAutoPending = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return false
    }
    return cardRealm.getSession(currentProjectId, card.id)?.restoreAutoPending === true
  })

  /** 当前打开卡片的跨列拖拽暂存落点（阶段 5 §六；null = 无待确认移动） */
  const pendingPlacement = computed<CardPendingPlacement | null>(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return null
    }
    const placement = cardRealm.getSession(currentProjectId, card.id)?.pendingPlacement
    return placement ? { ...placement } : null
  })

  /**
   * 应用/确认的统一门槛：操作态所在会话无未决冲突与守护。与放弃操作态不同，
   * 不要求 clean——§五.2.2 应用时把同轮未落盘草稿与判定结论合并为一次整体
   * 保存（显式保存固定当时快照，不等两秒计时）；冲突/守护仍要先解决版本关系。
   */
  const judgmentBlocked = computed(() => {
    const card = activeCard.value
    if (!card || currentProjectId == null) {
      return true
    }
    const session = cardRealm.getSession(currentProjectId, card.id)
    return session === undefined || session.conflict !== undefined || session.guard !== undefined
  })

  /** 应用校正/确认恢复自动可点：操作态中、领域判定钩子已注入、无冲突守护 */
  const canConfirmAuthorCorrection = computed(() =>
    authorCorrectionIntent.value !== null && config.judgment !== undefined && !judgmentBlocked.value)
  const canConfirmRestoreAuto = computed(() =>
    isRestoreAutoPending.value && config.judgment !== undefined && !judgmentBlocked.value)

  /** 显式判定保存进行中（按钮禁用与重复提交防护；两个操作态互斥，共用一把锁） */
  const isConfirmingJudgment = ref(false)

  /**
   * 进入作者校正操作态：表单回填上次取消的暂存或卡片当前有效结论（领域注入
   * 默认值）；与恢复自动互斥。不请求收口——应用时与未落盘草稿合并保存。
   * seed.status 供看板拖动入口（阶段 5）指定目标状态；placement 是跨列拖拽的
   * 暂存落点（§六）——「应用校正」一次保存判定与落点，取消不执行移动。已有
   * 表单时拖动入口同样生效：目标状态同步预选（表单可再改）、落点更新。
   */
  function startAuthorCorrection(
    projectId: string,
    seed?: { status?: string },
    placement?: CardPendingPlacement,
  ): boolean {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.judgment === undefined) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session) {
      return false
    }
    let changed = false
    if (!session.authorCorrection) {
      const base = session.lastAuthorCorrection ?? config.judgment.defaultCorrection(card)
      session.authorCorrection = {
        ...base,
        ...(seed?.status !== undefined
          ? { status: seed.status, deviationFlag: seed.status === 'deviated' }
          : {}),
      }
      delete session.restoreAutoPending
      changed = true
    } else if (seed?.status !== undefined && session.authorCorrection.status !== seed.status) {
      // 与表单状态选择器同一联动：状态切换时偏差结论同步（规划中/已写无偏差、偏差有偏差）
      session.authorCorrection = {
        ...session.authorCorrection,
        status: seed.status,
        deviationFlag: seed.status === 'deviated',
      }
      changed = true
    }
    if (placement && (session.pendingPlacement?.status !== placement.status
      || session.pendingPlacement?.afterId !== placement.afterId
      || session.pendingPlacement?.beforeId !== placement.beforeId)) {
      session.pendingPlacement = { ...placement }
      changed = true
    }
    if (changed) {
      session.updatedAt = new Date().toISOString()
      scheduleSessionMirror(session)
    }
    return true
  }

  /** 校正表单输入（只更新操作态，不触发自动保存） */
  function updateAuthorCorrection(projectId: string, patch: Partial<CardAuthorCorrectionIntent>): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.authorCorrection) {
      return
    }
    session.authorCorrection = { ...session.authorCorrection, ...patch }
    session.updatedAt = new Date().toISOString()
    scheduleSessionMirror(session)
  }

  /** 取消校正：退出表单态，回到先前编辑现场；已填表单暂存（再次进入回填）。
   * 跨列暂存落点一并丢弃（取消不执行移动，落点不暂存——要移动重新拖）。 */
  function cancelAuthorCorrection(projectId: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session?.authorCorrection) {
      return
    }
    session.lastAuthorCorrection = { ...session.authorCorrection }
    delete session.authorCorrection
    delete session.pendingPlacement
    session.updatedAt = new Date().toISOString()
    if (config.isEmptyDraft(session.draft) && session.abandon === undefined
      && session.reasonRevision === undefined && session.restoreAutoPending === undefined) {
      removeCardBackup(projectId, card.id)
    } else {
      scheduleSessionMirror(session)
    }
  }

  /**
   * 应用校正（明确操作，§五.2.2）：点击时固定当时完整快照——表单结论与同轮
   * 未落盘草稿合并为一次整体保存（引擎显式保存：请求时固定快照、同键串行、
   * 版本校验、失败不自动补试）。成功后有效结论立即更新（引擎回执同步看板与
   * 详情）；失败保留全部输入（表单与草稿都在）并就地呈现原因；冲突进入冲突
   * 处理（外部修改已冻结确认）。领域校验（如「有偏差必须填写说明」）同样
   * 保留输入。
   */
  async function confirmAuthorCorrection(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.judgment === undefined || isConfirmingJudgment.value) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    const intent = session?.authorCorrection
    if (!session || !intent || !session.diskCard || judgmentBlocked.value) {
      return false
    }
    const deviationNote = intent.deviationNote.trim()
    if (intent.deviationFlag && !deviationNote) {
      actionError.value = '作者校正为有偏差时必须填写偏差说明'
      return false
    }
    session.pendingJudgmentSave = {
      kind: 'authorCorrection',
      status: intent.status,
      deviationFlag: intent.deviationFlag,
      deviationNote,
    }
    isConfirmingJudgment.value = true
    actionError.value = ''
    try {
      const result = await cardRealm.requestExplicitSave(projectId, card.id)
      if (result.status === 'skipped') {
        // 会话被清除/守护到达：操作未执行，瞬态载荷作废（表单保留）
        delete session.pendingJudgmentSave
        return false
      }
      if (result.status === 'saved') {
        delete session.authorCorrection
        delete session.lastAuthorCorrection
        delete session.pendingPlacement
        settleMirrorAfterExplicitOp(projectId, session)
        return true
      }
      // failed / conflict：引擎已登记失败与冲突并同步现场；表单、草稿与操作态
      // 全部保留，用户处理后再试
      return false
    } finally {
      isConfirmingJudgment.value = false
    }
  }

  /**
   * 进入恢复自动确认态（两步确认第一步，§五.3）：界面展示「当前作者结论 →
   * 按最新值与阈值预演的自动结论」，确认才落盘。与作者校正操作态互斥：进入时
   * 未应用的校正表单按取消暂存（不丢输入）。
   */
  function startRestoreAuto(projectId: string): boolean {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.judgment === undefined) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session) {
      return false
    }
    if (!session.restoreAutoPending) {
      if (session.authorCorrection) {
        session.lastAuthorCorrection = { ...session.authorCorrection }
        delete session.authorCorrection
      }
      // 落点属于校正操作态：恢复自动按最新值重算状态，不消费拖拽落点，一并丢弃
      delete session.pendingPlacement
      session.restoreAutoPending = true
      session.updatedAt = new Date().toISOString()
      scheduleSessionMirror(session)
    }
    return true
  }

  /** 取消恢复自动：退出确认态，回到先前编辑现场（人工结论与输入都不动） */
  function cancelRestoreAuto(projectId: string): void {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId) {
      return
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session || session.restoreAutoPending !== true) {
      return
    }
    delete session.restoreAutoPending
    session.updatedAt = new Date().toISOString()
    if (config.isEmptyDraft(session.draft) && session.abandon === undefined
      && session.reasonRevision === undefined && session.authorCorrection === undefined) {
      removeCardBackup(projectId, card.id)
    } else {
      scheduleSessionMirror(session)
    }
  }

  /**
   * 确认恢复自动（§五.3）：固定当时完整快照，按最新计划值、实际值与阈值一次
   * 保存（同轮未落盘草稿合并提交）；不清空实际值，作者历史说明保留。成功后
   * 有效来源切回自动；失败或冲突时人工结论与输入保留。
   */
  async function confirmRestoreAuto(projectId: string): Promise<boolean> {
    const card = activeCard.value
    if (!card || currentProjectId !== projectId || config.judgment === undefined || isConfirmingJudgment.value) {
      return false
    }
    const session = cardRealm.getSession(projectId, card.id)
    if (!session || session.restoreAutoPending !== true || !session.diskCard || judgmentBlocked.value) {
      return false
    }
    session.pendingJudgmentSave = { kind: 'restoreAuto' }
    isConfirmingJudgment.value = true
    actionError.value = ''
    try {
      const result = await cardRealm.requestExplicitSave(projectId, card.id)
      if (result.status === 'skipped') {
        delete session.pendingJudgmentSave
        return false
      }
      if (result.status === 'saved') {
        delete session.restoreAutoPending
        settleMirrorAfterExplicitOp(projectId, session)
        return true
      }
      return false
    } finally {
      isConfirmingJudgment.value = false
    }
  }

  /** 显式判定保存成功后的镜像收口：草稿与其余操作态都干净时清镜像，否则保留 */
  function settleMirrorAfterExplicitOp(projectId: string, session: CardSaveSession<TDraft, TCard>): void {
    if (config.isEmptyDraft(session.draft)
      && session.abandon === undefined && session.reasonRevision === undefined
      && session.authorCorrection === undefined && session.restoreAutoPending === undefined
      && session.pendingPlacement === undefined) {
      removeCardBackup(projectId, session.cardId)
    } else {
      scheduleSessionMirror(session)
    }
  }

  /**
   * 重新进入项目时从浏览器恢复镜像回填卡片会话（不写盘；核对规则见
   * save-session：内容已一致清冗余；基线一致回填待续存；磁盘已变建立冲突；
   * 卡片已删进入删除守护）。
   */
  async function restoreCardDrafts(projectId: string): Promise<SaveSessionRestoreReport> {
    const records = await loadProjectCardBackups(projectId)
    const report = await cardRealm.restoreSessions(
      projectId,
      records.map((record) => ({
        key: record.cardId,
        snapshot: record.draft as unknown as TDraft,
        baseSnapshot: config.emptyDraft(),
        ...(record.baseContentHash !== undefined ? { baseVersion: record.baseContentHash } : {}),
        // 带操作态（放弃/原因修订/作者校正/恢复自动）的记录：草稿内容即使已
        // 全部落盘也不做冗余清理，保留会话让下方回填操作态（阶段 4）
        ...(record.abandon !== undefined || record.reasonRevision !== undefined
          || record.authorCorrection !== undefined || record.restoreAutoPending !== undefined
          || record.pendingPlacement !== undefined
          ? { keepAlive: true } : {}),
        updatedAt: record.updatedAt,
      })),
    )
    // 记录里携带的编辑模式与待确认操作态回填到会话（重开时恢复视图态；
    // 操作态恢复后仍待用户再次明确确认，绝不自动执行——阶段 4）
    for (const record of records) {
      const session = cardRealm.getSession(projectId, record.cardId)
      if (session) {
        session.mode = record.mode
        if (record.abandon !== undefined) {
          session.abandon = { ...record.abandon }
        }
        if (record.reasonRevision !== undefined) {
          session.reasonRevision = { ...record.reasonRevision }
        }
        if (record.authorCorrection !== undefined) {
          session.authorCorrection = { ...record.authorCorrection }
        }
        if (record.restoreAutoPending !== undefined) {
          session.restoreAutoPending = true
        }
        if (record.pendingPlacement !== undefined) {
          session.pendingPlacement = { ...record.pendingPlacement }
        }
      }
    }
    // 回填待续存会话的磁盘基线（阶段 2 自动续存）：引擎的恢复核对只建立会话，
    // 卡片域组装提交需要磁盘基线（diskCard）；基线一致已核对过的会话预读当前
    // 卡片，两秒后的自动保存才能真实落盘。读不到（已删/读取异常）保持无基线，
    // 首次自动保存会以明确错误停住，等用户打开卡片重建现场。
    for (const entry of report.restored) {
      const session = cardRealm.getSession(projectId, entry.key)
      if (!session || session.diskCard) {
        continue
      }
      try {
        const card = await config.readCard(projectId, entry.key)
        if (card) {
          session.diskCard = card
          if (!config.draftDiffers(card, session.draft)) {
            // 草稿内容已全部落盘（keepAlive 保留的会话）：收敛为空模板让会话
            // 呈 clean——续存只为放弃操作态，不再触发冗余自动保存与镜像续写
            cardRealm.setInput(projectId, entry.key, config.emptyDraft())
          }
        }
      } catch {
        // 读取失败：保持无基线，保存入口的明确错误兜底
      }
    }
    return report
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

  /** 打开新建面板（看板右上 / 空状态入口共用）：切换展示对象，当前卡片待写内容收口（草稿仍随会话保留） */
  function openCreate() {
    if (isCreateOpen.value) return
    if (activeCard.value && currentProjectId != null) {
      void cardRealm.flushSession(currentProjectId, activeCard.value.id)
    }
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
   * 状态切换 / 拖拽排序的统一入口（立即保存）。afterId 为目标位置前一卡片；
   * 列首落点改传 beforeId（目标列首卡，null = 空列/列首）。松手后先把卡片
   * 本地移到目标位置（不等写盘与目录重扫），成功后刷新看板以文件系统为准；
   * 失败保留错误提示并刷新回真实状态。按 ID 同步当前详情（状态高亮 + 最新
   * contentHash），不动草稿；异步期间用户已切到其他卡片时不回写旧详情。
   */
  async function moveCard(
    projectId: string,
    id: string,
    status: TStatus,
    afterId: string | null,
    beforeId?: string | null,
  ) {
    const generation = beginProject(projectId)
    actionError.value = ''
    const previousBoard = board.value
    const nextBoard = previousBoard
      ? moveCardInBoard(previousBoard, id, status, beforeId !== undefined ? null : afterId, beforeId)
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
      const updated = await config.moveCard(projectId, id, status, afterId, beforeId)
      if (!isCurrentProject(projectId, generation)) return true
      if (activeCard.value?.id === id) {
        activeCard.value = updated
      }
      // 同步会话磁盘基线：移动改写了文件（contentHash 变化），当前卡的后续
      // 保存按新 hash 校验，未保存草稿保留。
      const session = cardRealm.getSession(projectId, id)
      if (session) {
        session.diskCard = updated
        session.baseContentHash = updated.contentHash
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

      // 删除后清除该卡片的编辑会话（含恢复镜像），删除当前打开的卡片时一并关闭详情
      cardRealm.clearSession(projectId, id)
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
    // 切项目收口（阶段 2）：待写内容尽力落盘——写盘链已捕获会话引用，
    // 后续清表不取消已请求的写入；失败时恢复镜像兜底
    void cardRealm.flushAllSessions()
    projectGeneration += 1
    currentProjectId = null
    openSequence += 1
    createSequence += 1
    manualSaveInFlight.clear()
    isCreating.value = false
    createDetached = false
    board.value = null
    isLoading.value = false
    boardSyncSource.value = 'auto'
    activeCard.value = null
    detailMode.value = 'preview'
    conflictNotice.value = null
    actionError.value = ''
    detailError.value = null
    detailNotice.value = null
    lastSavedCard.value = null
    errorMessage.value = ''
    selectedCardId.value = null
    isCreateOpen.value = false
    createDraft.value = config.emptyCreateDraft()
    // 作废全部副本操作：在途结果晚到时按代次比对丢弃，不回写到新项目的卡片
    conflictCopyStates.value = {}
    conflictCopyTokens.clear()
    // 清空全部卡片会话与恢复镜像（切项目后现场不跨项目保留；
    // 刷新场景的恢复由 IndexedDB 记录在下次进入项目时核对回填）
    for (const session of cardRealm.listAllSessions()) {
      cardRealm.clearSession(session.projectId, session.cardId)
    }
  }

  return {
    board,
    isLoading,
    errorMessage,
    /** 当前项目 id（非响应式读取；领域做项目级派生计算用） */
    getActiveProjectId: () => currentProjectId,
    boardSyncSource,
    manualRefreshedCount,
    activeCard,
    draft,
    detailMode,
    editSessions,
    isSaving,
    savePhase,
    saveFailureMessage,
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
    conflictView,
    conflictFields,
    guardNotice,
    expandCardConflict,
    collapseCardConflict,
    adoptDiskVersion,
    overwriteWithMine,
    saveConflictCopy,
    restoreConflictCopy,
    conflictCopyBusy,
    conflictCopyError,
    discardGuardedSession,
    abandonIntent,
    canConfirmAbandon,
    isConfirmingAbandon,
    startAbandon,
    updateAbandonReason,
    cancelAbandon,
    confirmAbandonCard,
    reasonRevisionIntent,
    canConfirmReasonRevision,
    isConfirmingReasonRevision,
    startReasonRevision,
    updateReasonRevision,
    cancelReasonRevision,
    confirmReasonRevision,
    authorCorrectionIntent,
    isRestoreAutoPending,
    pendingPlacement,
    canConfirmAuthorCorrection,
    canConfirmRestoreAuto,
    isConfirmingJudgment,
    startAuthorCorrection,
    updateAuthorCorrection,
    cancelAuthorCorrection,
    confirmAuthorCorrection,
    startRestoreAuto,
    cancelRestoreAuto,
    confirmRestoreAuto,
    freezeForExternalChange,
    hasCardDraft,
    setCardGuard,
    restoreCardDrafts,
    retrySave,
    flushCard,
    flushAllCards,
    setCardAutosaveEnabled,
    setupCardSaveLifecycle,
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

/** 两份字段草稿逐字段相等（引擎脏判定；字段值为标量或 null） */
function isSameDraft<TDraft extends object>(left: TDraft, right: TDraft): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key as keyof TDraft] !== right[key as keyof TDraft]) {
      return false
    }
  }
  return true
}

function toMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
