import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  respondConfirmation as respondAgentConfirmation,
  respondQuestion as respondAgentQuestion,
  skipQuestion as skipAgentQuestion,
  enqueueMessage as enqueueAgentMessage,
  updateQueuedMessage as updateAgentQueuedMessage,
  loadOlderMessages as loadOlderAgentMessages,
  stopAgentRun,
  isAgentRunActive,
  subscribeAgentEvents,
  getSession as getAgentSession,
  listSessions as listAgentSessions,
  renameSession as renameAgentSession,
  deleteSession as deleteAgentSession,
  archiveAgentSession,
  compactSession as compactAgentSession,
} from '@novai/core/services/agent-service'

import type {
  AgentRoleId,
  AgentUiEvent,
  AskUserQuestionRequestView,
  ChangedFileView,
  ChatMessageView,
  ChatSessionSummaryView,
  ChatSessionView,
  FileChangeConfirmationView,
  FileChangeRecordView,
  QueuedMessageView,
} from '@novai/core/services/types'

import { buildRenderItems, type ChatRenderItem } from './chat-render'
import { useProjectStore } from './project'
import { getOrCreateClientId } from '../utils/client-id'

/** runStatus 的语义类型，供状态栏按类型上色，避免 UI 靠字符串猜测 */
export type RunStatusType = 'idle' | 'running' | 'error'

/** 实时文件改动 + 产生它的会话（定位高亮据此判定「是否当前会话的改动」） */
export type RecentFileChange = {
  sessionId: string
  record: FileChangeRecordView
}

/**
 * 历史窗口页大小（借鉴 dsh 分页防线）：首屏只装尾部一页，滚动到顶向前翻页。
 * 取 100 而非 dsh 的 50——一轮 Agent 任务产生多条工具行，50 条可能不足两轮。
 */
export const HISTORY_PAGE_SIZE = 100

export const useChatStore = defineStore('chat', () => {
  const sessionView = ref<ChatSessionView | null>(null)
  /** 会话级改动清单（按目标路径去重；来源：run-finish 全量 / 会话 view / file-changed 实时合并） */
  const changedFiles = ref<ChangedFileView[]>([])
  /**
   * 最近一条实时到达的文件改动（file-changed 事件原文，不做去重合并）。
   * 内容面板据此判断是否重读当前打开的文件；与 changedFiles 的分工：
   * 那份是去重后的清单（树刷新的 watch 源），这份保留逐条到达顺序（同文件反复改
   * 也逐条触发，不因去重漏掉重读时机）。
   */
  const lastFileChange = ref<FileChangeRecordView | null>(null)
  /**
   * 实时到达的文件改动队列（file-changed 事件按到达序逐条保留，含会话归属）：
   * 定位高亮反馈队列（交互优化计划 §7）的数据源。与 lastFileChange 的分工：那份只留
   * 最新一条（内容面板重读触发），这份逐条保留——同文件连续多次修改不互相吞掉。
   * 上限 30 条，最老的先出；切项目时由 ProjectView 清空（跨项目不串扰）。
   */
  const recentFileChanges = ref<RecentFileChange[]>([])
  /** 收件箱队列快照（QueueDock 渲染用），由 queue-updated 事件同步、切换会话时从 view 重建 */
  const queue = ref<QueuedMessageView[]>([])
  const runStatus = ref('还没有开始执行。')
  // runStatus 的语义类型，供状态栏按类型上色（idle 灰 / running 蓝 / error 红）
  const runStatusType = ref<RunStatusType>('idle')
  // 事件驱动：run-start 置真、run-finish/run-error 置假（driver 后台跑，不再由单次 await 的 finally 控制）
  const isRunning = ref(false)
  // 用户已请求停止、正在等待当前工具执行完成
  const isStopping = ref(false)
  /**
   * 各会话的待确认快照（confirmation-required / confirmations-updated 事件同步）：
   * 确认链按会话路由——委派中的要素管理员会话等待确认时，激活的主会话不受影响；
   * 非激活会话的待确认由会话列表读它点亮「待确认」徽标。
   */
  const pendingConfirmationsBySession = ref(new Map<string, FileChangeConfirmationView[]>())
  // 当前激活会话的待确认卡（一次一张，取最早到达的那条；Agent Loop 在此暂停）
  const pendingConfirmation = computed<FileChangeConfirmationView | null>(() => {
    const active = activeSessionId.value
    if (!active) {
      return null
    }
    return pendingConfirmationsBySession.value.get(active)?.[0] ?? null
  })
  /** 激活会话待确认队首是否为内容类（create/edit）：走右侧内容面板审阅（§8）；rename/delete 走输入区接管 */
  const activeWriteConfirmation = computed<FileChangeConfirmationView | null>(() => {
    const head = pendingConfirmation.value
    if (!head || (head.confirmation.kind !== 'create' && head.confirmation.kind !== 'edit')) {
      return null
    }
    return head
  })
  /** 激活会话待确认总数（内容面板审阅区「第 x / 共 n 项」用） */
  const pendingConfirmationCount = computed<number>(() => {
    const active = activeSessionId.value
    if (!active) {
      return 0
    }
    return pendingConfirmationsBySession.value.get(active)?.length ?? 0
  })
  /**
   * 各会话的待回答提问快照（question-required / questions-updated 事件同步，仿确认链）：
   * Agent 任务中途的 AskUserQuestion 挂起在这里。切换会话后回来仍能恢复等待态；
   * 刷新后为空（core 不重放事件），无 answer 的卡片据此标记「等待已中断」。
   */
  const pendingQuestionsBySession = ref(new Map<string, AskUserQuestionRequestView[]>())
  // 当前激活会话的待回答提问（一次只处理一个，取最早到达的那条）
  const pendingQuestion = computed<AskUserQuestionRequestView | null>(() => {
    const active = activeSessionId.value
    if (!active) {
      return null
    }
    return pendingQuestionsBySession.value.get(active)?.[0] ?? null
  })
  /**
   * 当前提问的作答草稿（卡片与输入框改道共用）：候选项选择集合 + 补充文本。
   * pendingQuestion 变化（新问题到达 / 已作答清空）时重置。
   */
  const questionSelection = ref<string[]>([])
  const questionText = ref('')
  /** 提问作答在途（提交按钮防重复点击；respondQuestion 同步收敛，通常只闪一瞬） */
  const isSubmittingAnswer = ref(false)
  // 当前正在流式输出的消息 id（供消息气泡显示「生成中」光标）；无流式消息时为 null
  const streamingMessageId = ref<string | null>(null)

  // 历史会话列表（对话分类面板渲染），按 updatedAt 降序
  const sessions = ref<ChatSessionSummaryView[]>([])
  // 当前激活会话 id（高亮 + 事件路由用）
  const activeSessionId = ref<string | null>(null)
  const isLoadingSessions = ref(false)
  /**
   * 各会话的运行中标记（事件驱动，会话列表「进行中」筛选与状态徽标的实时来源）：
   * run-start 记入、run-finish/run-error 以 driver 注册表真实状态收敛。
   * 不受激活会话过滤影响——后台委派会话运行时列表同样要点亮；
   * 刷新后为空（core 的 driver 注册表在内存），快照 status='running' 不作为运行依据。
   */
  const runningSessionIds = ref(new Set<string>())

  /**
   * 历史窗口起点：sessionView.messages[0] 在全量历史中的下标（append-only 数组下标游标）。
   * 0 = 已加载全部；>0 = 之上还有更早历史可翻页。
   */
  const historyStart = ref(0)
  /** 正在向前翻页（loadOlderHistory 在途），UI 显示加载态并防重入 */
  const loadingOlder = ref(false)
  /** 之上是否还有更早历史（驱动滚动到顶自动加载） */
  const hasMoreHistory = computed(() => historyStart.value > 0)

  const hasSessionView = computed(() => sessionView.value !== null)
  const messages = computed<ChatMessageView[]>(() => sessionView.value?.messages ?? [])

  /** 有待确认的会话 id 集（会话列表徽标）：非激活的委派会话等待用户打开确认。 */
  const sessionsWithPendingConfirmations = computed(() =>
    new Set(
      [...pendingConfirmationsBySession.value.entries()]
        .filter(([, list]) => list.length > 0)
        .map(([sessionId]) => sessionId),
    ),
  )

  /** 有待回答提问的会话 id 集（会话列表「待回答」徽标）。 */
  const sessionsWithPendingQuestions = computed<Set<string>>(() =>
    new Set(
      [...pendingQuestionsBySession.value.entries()]
        .filter(([, list]) => list.length > 0)
        .map(([sessionId]) => sessionId),
    ),
  )

  /**
   * 会话后台保存失败记录（数据安全计划 §3-4 会话保存失败可见）：
   * 前台保存（用户在等）由调用方 await 直接呈现；后台落盘（归档收尾、提问卡等）
   * 失败时 core 广播 session-save-failed，这里按会话去重登记（最新一次覆盖）。
   * 列表常驻供错误条持续展示（F11），用户处理后 dismiss。
   */
  const sessionSaveFailures = ref(new Map<string, { sessionId: string; reason: string; message: string; at: string }>())

  /** 登记一条后台保存失败（同会话最新一次覆盖） */
  function recordSessionSaveFailure(event: {
    sessionId: string
    reason: string
    message: string
  }) {
    sessionSaveFailures.value = new Map(sessionSaveFailures.value).set(event.sessionId, {
      sessionId: event.sessionId,
      reason: event.reason,
      message: event.message,
      at: new Date().toISOString(),
    })
  }

  /** 用户已处理（重试成功/知悉）后移除该会话的失败记录 */
  function dismissSessionSaveFailure(sessionId: string) {
    if (!sessionSaveFailures.value.has(sessionId)) {
      return
    }
    const next = new Map(sessionSaveFailures.value)
    next.delete(sessionId)
    sessionSaveFailures.value = next
  }

  /**
   * 任务组折叠态：组 id（= 组首 user 消息 id）→ 显式展开/收起，优先级高于默认
   * （默认：历史轮收起，运行中的最后一轮展开）。切换会话不清。
   */
  const expandedGroups = ref(new Map<string, boolean>())

  /** 渲染序列（文档 3 S4）：tool-call/result 配对成行 + 一轮任务过程消息折叠成组；组件只负责渲染。 */
  const renderItems = computed<ChatRenderItem[]>(() =>
    buildRenderItems(messages.value, {
      running: isRunning.value,
      expandedOverrides: expandedGroups.value,
    }),
  )

  /** 用户点击折叠组头：写显式覆盖值（展开 true / 收起 false）。 */
  function toggleProcessGroup(id: string, expanded: boolean) {
    expandedGroups.value.set(id, expanded)
  }

  /**
   * 项目打开时的会话初始化入口：
   * 拉取历史会话列表；有恢复记录时优先激活记录的会话（工作区现场恢复，§3.4），
   * 记录缺失/失效回退最近一条，无历史则新建。
   * 取代旧的 ensureSessionView（后者只支持单会话）。
   */
  async function initSessions(projectId: string, preferredSessionId?: string | null): Promise<ChatSessionView> {
    // 进入新项目：上一项目的后台保存失败记录不再有意义（§3-4）
    sessionSaveFailures.value = new Map()
    await loadSessions(projectId)

    if (preferredSessionId && sessions.value.some((s) => s.sessionId === preferredSessionId)) {
      const restored = await selectSession(projectId, preferredSessionId)
      if (restored) {
        return restored
      }
      // 记录的会话读取失败（文件损坏等）：回退最近一条，不让打开流程失败
    }

    if (sessions.value.length > 0) {
      await selectSession(projectId, sessions.value[0].sessionId)
      return sessionView.value!
    }

    // 无历史：新建。列表刚拉过且为空，跳过 createNewSession 内部的二次全量扫描，
    // 直接本地插入新会话摘要。
    return createNewSession(projectId, { skipReload: true })
  }

  /**
   * 拉取并刷新历史会话列表。
   * 只负责更新列表数据，**不修改 activeSessionId**——激活态的清理由明确语义的调用点
   * （如 deleteSession）自行处理，避免列表刷新与激活态维护耦合产生的竞态误清。
   */
  async function loadSessions(projectId: string) {
    isLoadingSessions.value = true
    try {
      sessions.value = await listAgentSessions(projectId)
    } finally {
      isLoadingSessions.value = false
    }
  }

  /**
   * 把事件带来的会话摘要 upsert 进列表（session-created）：
   * 原地替换同名项或插入新项，保持 updatedAt 降序。
   */
  function upsertSessionSummary(summary: ChatSessionSummaryView) {
    const rest = sessions.value.filter((s) => s.sessionId !== summary.sessionId)
    rest.unshift(summary)
    rest.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    sessions.value = rest
  }

  /** 切换到指定历史会话：只装尾部一页消息窗口（长会话分页防线）并设为激活。 */
  async function selectSession(projectId: string, sessionId: string): Promise<ChatSessionView | null> {
    const view = await getAgentSession(projectId, sessionId, { tailMessages: HISTORY_PAGE_SIZE })
    if (!view) {
      return null
    }

    sessionView.value = view
    activeSessionId.value = sessionId
    // 切换会话时清空上一轮的运行态残留，避免跨会话串扰；
    // 队列/改动清单/运行态从目标会话的 view 与 driver 注册表重建
    changedFiles.value = view.changedFiles ?? []
    lastFileChange.value = null
    queue.value = view.queuedMessages ?? []
    streamingMessageId.value = null
    historyStart.value = view.historyStart ?? 0
    loadingOlder.value = false
    isRunning.value = isAgentRunActive(sessionId)
    isStopping.value = false
    return view
  }

  /**
   * 向前翻一页历史（滚动到顶触发）：prepend 到 messages 头部，窗口起点前移。
   * 防重入：无更多历史 / 在途 / 无会话时直接返回。返回是否取到了新页（供 UI 锚定）。
   */
  async function loadOlderHistory(): Promise<boolean> {
    const view = sessionView.value
    if (!view || !hasMoreHistory.value || loadingOlder.value) {
      return false
    }

    loadingOlder.value = true
    try {
      const page = await loadOlderAgentMessages(view.projectId, view.sessionId, {
        before: historyStart.value,
        count: HISTORY_PAGE_SIZE,
      })
      // 会话被删 / 已切走：静默丢弃，不污染当前视图
      if (!page || sessionView.value?.sessionId !== view.sessionId) {
        return false
      }
      if (page.messages.length === 0) {
        historyStart.value = page.start
        return false
      }
      sessionView.value = {
        ...view,
        messages: [...page.messages, ...view.messages],
      }
      historyStart.value = page.start
      return true
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '加载更早消息失败', 'error')
      return false
    } finally {
      loadingOlder.value = false
    }
  }

  /**
   * 新建会话：创建 + 激活 + 刷新列表。
   * - agent：指定驱动角色（缺省主角色）；'element-manager' 新建要素管理员直聊会话。
   * - skipReload=true 时跳过内部全量刷新（调用方已确知列表状态，如 initSessions 走过 loadSessions、
   *   或 deleteSession 清空后），改为本地插入新会话摘要到列表头部。
   */
  async function createNewSession(
    projectId: string,
    options: { skipReload?: boolean; agent?: AgentRoleId } = {},
  ): Promise<ChatSessionView> {
    const view = await createAgentSession(
      projectId,
      options.agent !== undefined ? { agent: options.agent } : undefined,
    )
    sessionView.value = view
    activeSessionId.value = view.sessionId
    changedFiles.value = []
    lastFileChange.value = null
    queue.value = []
    historyStart.value = 0
    loadingOlder.value = false
    isRunning.value = false
    isStopping.value = false

    if (options.skipReload) {
      sessions.value = [{
        sessionId: view.sessionId,
        projectId,
        ...(view.agent ? { agent: view.agent } : {}),
        status: view.status,
        title: view.title ?? '新对话',
        createdAt: view.createdAt ?? new Date().toISOString(),
        updatedAt: view.updatedAt ?? new Date().toISOString(),
        messageCount: 0,
      }, ...sessions.value]
    } else {
      await loadSessions(projectId)
    }
    return view
  }

  /** 重命名会话标题，并同步列表对应项。 */
  async function renameSession(projectId: string, sessionId: string, title: string): Promise<void> {
    const view = await renameAgentSession(projectId, sessionId, title)
    // 同步列表项标题
    sessions.value = sessions.value.map((s) =>
      s.sessionId === sessionId ? { ...s, title: view.title ?? s.title } : s,
    )
    // 若是当前会话，同步视图
    if (sessionView.value?.sessionId === sessionId) {
      sessionView.value = { ...sessionView.value, title: view.title }
    }
  }

  /**
   * 删除会话；若删的是当前激活会话，则切到列表第一条或新建空会话。
   * 删光后保留一个空「新对话」是有意为之：否则 UI 进入无活跃会话态，发消息会报错。
   */
  async function deleteSession(projectId: string, sessionId: string): Promise<void> {
    await deleteAgentSession(projectId, sessionId)

    const wasActive = activeSessionId.value === sessionId
    // 先从本地列表移除，避免 await 期间 UI 闪烁残留项
    sessions.value = sessions.value.filter((s) => s.sessionId !== sessionId)

    if (!wasActive) {
      return
    }

    // 删的是当前会话：切到剩余的第一条（列表已按 updatedAt 降序）
    if (sessions.value.length > 0) {
      await selectSession(projectId, sessions.value[0].sessionId)
      return
    }

    // 列表已空：新建空会话并本地插入，省一次全量重扫（skipReload）
    await createNewSession(projectId, { skipReload: true })
  }

  /**
   * 归档会话（交互优化计划 §3）：不弹确认、不停止运行中的 driver，只改列表可见性。
   * 归档的是激活会话时自动切到最近的未归档会话（没有则新建空会话）；
   * 归档其他会话不改变当前现场。
   * 返回 fallbackTo = 归档激活会话时自动切到的会话 id——撤销动作据此判断能否
   * 切回原会话（用户后来手动切走则不抢占）。
   */
  async function archiveSession(
    projectId: string,
    sessionId: string,
  ): Promise<{ fallbackTo: string | null }> {
    const summary = await archiveAgentSession(projectId, sessionId, true)
    upsertSessionSummary(summary)

    if (activeSessionId.value !== sessionId) {
      return { fallbackTo: null }
    }

    const next = sessions.value.find((s) => !s.archivedAt)
    if (next) {
      await selectSession(projectId, next.sessionId)
      return { fallbackTo: next.sessionId }
    }

    // 全部已归档：新建空会话兜底（否则 UI 进入无活跃会话态，发消息会报错）
    await createNewSession(projectId)
    return { fallbackTo: activeSessionId.value }
  }

  /**
   * 恢复归档（撤销与归档区「恢复」共用）：只清归档标记，不动活动时间、不改激活会话
   * ——是否切回原会话由撤销方按 fallbackTo 上下文决定，长期恢复不抢占现场。
   */
  async function unarchiveSession(projectId: string, sessionId: string): Promise<void> {
    const summary = await archiveAgentSession(projectId, sessionId, false)
    upsertSessionSummary(summary)
  }

  /**
   * 发送入口：入队先于唤醒，立即返回（driver 在后台跑，进展经事件总线回流）。
   * - mode 'queue'：next-turn 排队（空闲时效果等同直接发送）；
   * - mode 'steer'：next-step 插话，下一 step 边界生效（仅运行中有意义）。
   * 返回是否入队成功：失败时 UI 负责把草稿填回输入框（dsh restoreFailedDrafts 简单版）。
   */
  async function sendMessage(
    text: string,
    quote?: string,
    mode: 'queue' | 'steer' = 'queue',
    displayLabel?: string,
  ): Promise<boolean> {
    if (!sessionView.value) {
      setRunStatus('没有活跃的会话', 'error')
      return false
    }

    // 把当前打开的文件路径作为隐式上下文传入，供 Agent 工具约束（如「只改当前文件」）解析使用。
    const projectStore = useProjectStore()
    try {
      await enqueueAgentMessage({
        projectId: sessionView.value.projectId,
        sessionId: sessionView.value.sessionId,
        text,
        quote,
        mode,
        // 显示/指令分离：斜杠命令时传用户原草稿（气泡、队列、自动标题用它，不暴露内部 prompt）
        ...(displayLabel !== undefined ? { displayLabel } : {}),
        activeFilePath: projectStore.activeFile?.path ?? null,
        // 匿名联网配额身份：随消息注入，沿 ChatTurnInput → ToolRuntime 到达 WebSearch/WebFetch
        webClientId: getOrCreateClientId(),
      })
      return true
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '发送失败', 'error')
      return false
    }
  }

  /** QueueDock 行内编辑排队消息；displayLabel = 编辑后的显示草稿（缺省清除命令标记）；失败抛错由 UI toast。 */
  async function editQueuedMessage(id: string, text: string, displayLabel?: string): Promise<void> {
    if (!sessionView.value) return
    await updateAgentQueuedMessage({
      projectId: sessionView.value.projectId,
      sessionId: sessionView.value.sessionId,
      id,
      action: { kind: 'edit', text, ...(displayLabel !== undefined ? { displayLabel } : {}) },
    })
  }

  /** QueueDock 撤回排队消息；失败抛错由 UI toast。 */
  async function removeQueuedMessage(id: string): Promise<void> {
    if (!sessionView.value) return
    await updateAgentQueuedMessage({
      projectId: sessionView.value.projectId,
      sessionId: sessionView.value.sessionId,
      id,
      action: { kind: 'remove' },
    })
  }

  /** QueueDock 把排队消息升级为插话（仅运行中可用，service 层校验）；失败抛错由 UI toast。 */
  async function steerQueuedMessage(id: string): Promise<void> {
    if (!sessionView.value) return
    await updateAgentQueuedMessage({
      projectId: sessionView.value.projectId,
      sessionId: sessionView.value.sessionId,
      id,
      action: { kind: 'steer' },
    })
  }

  /** 用户点击停止：abort 当前 turn，driver 在边界优雅收尾；队列保留不自动续跑。 */
  function abortRun() {
    if (!activeSessionId.value || !isRunning.value) {
      return
    }
    stopAgentRun(activeSessionId.value)
    // 立即进入「停止中」态：UI 反馈 + 等待当前工具完成
    isStopping.value = true
    setRunStatus('已请求停止，等待当前工具执行完成…', 'running')
  }

  /**
   * 手动压缩当前会话上下文（/压缩上下文）：摘要调用走一次真实 LLM 请求，
   * 期间状态栏显示进行中；结果写状态栏（context-summary 消息经事件总线回流渲染）。
   * 返回是否成功执行——noop（无可压缩/摘要被拒）也算执行完毕，失败时 UI 恢复草稿。
   */
  async function compactActiveSession(): Promise<boolean> {
    if (!sessionView.value) {
      setRunStatus('没有活跃的会话', 'error')
      return false
    }
    setRunStatus('正在压缩上下文…', 'running')
    try {
      const outcome = await compactAgentSession({
        projectId: sessionView.value.projectId,
        sessionId: sessionView.value.sessionId,
      })
      if (outcome.kind === 'compacted') {
        setRunStatus(`已压缩 ${outcome.compactedMessageCount} 条早期消息（约 ${outcome.originalTokens} → ${outcome.summaryTokens} token）`)
      } else if (outcome.reason === 'nothing-to-compact') {
        // 与消息流里的本地命令状态行同文案：主动取消或无变化不是错误
        setRunStatus('没有可压缩的早期历史，未做修改')
      } else {
        setRunStatus('压缩摘要未通过校验，上下文未改动', 'error')
      }
      return true
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '压缩失败', 'error')
      return false
    }
  }

  /**
   * 统一的 runStatus 写入入口：同时设置文案与语义类型，
   * UI（状态栏）按 type 上色，无需靠字符串匹配。
   */
  function setRunStatus(nextStatus: string, type: RunStatusType = 'idle') {
    runStatus.value = nextStatus
    runStatusType.value = type
  }

  /** file-changed 实时合并进会话级清单（目标路径去重、last-wins）；权威清单以 run-finish / 会话 view 为准。 */
  function applyFileChangeRecord(record: FileChangeRecordView) {
    const change = record.change
    const keyOf = (file: ChangedFileView) => (file.type === 'renamed' ? file.toPath : file.path)
    const key = keyOf(change)
    changedFiles.value = [
      ...changedFiles.value.filter(
        (file) => keyOf(file) !== key && !(change.type === 'renamed' && keyOf(file) === change.fromPath),
      ),
      change,
    ]
  }

  function handleAgentEvent(event: AgentUiEvent) {
    // 运行态集合全局维护（先于激活会话过滤）：后台委派会话运行时列表同样要点亮「进行中」。
    // run-finish/run-error 以注册表真实状态收敛——停止后立刻再发送时，新 run 的
    // run-start 可能先于旧 driver 的收尾事件到达，无条件删除会误清新 run。
    if (event.type === 'run-start') {
      runningSessionIds.value = new Set(runningSessionIds.value).add(event.sessionId)
    } else if ((event.type === 'run-finish' || event.type === 'run-error')
      && !isAgentRunActive(event.sessionId)) {
      const next = new Set(runningSessionIds.value)
      next.delete(event.sessionId)
      runningSessionIds.value = next
    }

    // 全局事件（与会话激活态无关，先于激活会话过滤处理）：
    // 待确认快照按会话路由，非激活会话（委派中的要素管理员会话）也要记录徽标；
    // session-created（服务端新建的委派会话落盘）刷新当前项目的会话列表。
    if (event.type === 'confirmation-required') {
      const list = pendingConfirmationsBySession.value.get(event.sessionId) ?? []
      pendingConfirmationsBySession.value = new Map(pendingConfirmationsBySession.value)
        .set(event.sessionId, [...list, event.request])
      if (event.sessionId === activeSessionId.value) {
        setRunStatus('等待确认写入操作…')
      }
      return
    }

    if (event.type === 'confirmations-updated') {
      pendingConfirmationsBySession.value = new Map(pendingConfirmationsBySession.value)
        .set(event.sessionId, event.confirmations)
      return
    }

    if (event.type === 'question-required') {
      const list = pendingQuestionsBySession.value.get(event.sessionId) ?? []
      pendingQuestionsBySession.value = new Map(pendingQuestionsBySession.value)
        .set(event.sessionId, [...list, event.request])
      if (event.sessionId === activeSessionId.value) {
        resetQuestionDraft()
        setRunStatus('Agent 正在等待你的回答…')
      }
      return
    }

    if (event.type === 'questions-updated') {
      pendingQuestionsBySession.value = new Map(pendingQuestionsBySession.value)
        .set(event.sessionId, event.questions)
      return
    }

    if (event.type === 'session-created') {
      const projectStore = useProjectStore()
      if (projectStore.currentProject?.id === event.projectId) {
        // 事件自带会话摘要，直接 upsert 进列表：事件后再遍历文件系统会在
        // 委派运行器的连发落盘窗口内漏掉刚创建的会话文件（真机复现），不可靠。
        upsertSessionSummary(event.summary)
      }
      return
    }

    // 后台保存失败（§3-4）：登记供持续展示，任何会话（含后台委派）都记；
    // 切项目时由 initSessions 清空重置
    if (event.type === 'session-save-failed') {
      recordSessionSaveFailure(event)
      return
    }

    // 其余事件只消费当前激活会话的（后台会话的 driver 仍在跑，UI 不跟随）
    if (!activeSessionId.value || event.sessionId !== activeSessionId.value) {
      return
    }

    if (event.type === 'run-start') {
      isRunning.value = true
      isStopping.value = false
      setRunStatus('Agent 正在执行...', 'running')
      return
    }

    if (event.type === 'message' && sessionView.value) {
      // 流式消息的完成事件与占位消息同 id：原位替换而非追加，避免重复气泡
      const exists = sessionView.value.messages.some((m) => m.id === event.message.id)
      sessionView.value = {
        ...sessionView.value,
        messages: exists
          ? sessionView.value.messages.map((m) => (m.id === event.message.id ? event.message : m))
          : [...sessionView.value.messages, event.message],
      }
      if (streamingMessageId.value === event.message.id) {
        streamingMessageId.value = null
      }
      return
    }

    if (event.type === 'message-delta' && sessionView.value) {
      const target = sessionView.value.messages.find((m) => m.id === event.messageId)
      if (target && target.kind === 'text') {
        // 已有占位/累积中的消息：追加文本
        sessionView.value = {
          ...sessionView.value,
          messages: sessionView.value.messages.map((m) =>
            m.id === event.messageId && m.kind === 'text' ? { ...m, text: m.text + event.text } : m,
          ),
        }
      } else {
        // 首个 delta：创建占位 assistant 文本消息
        sessionView.value = {
          ...sessionView.value,
          messages: [...sessionView.value.messages, {
            id: event.messageId,
            role: 'assistant',
            kind: 'text',
            text: event.text,
            createdAt: new Date().toISOString(),
          }],
        }
      }
      streamingMessageId.value = event.messageId
      return
    }

    if (event.type === 'message-reasoning-delta' && sessionView.value) {
      const target = sessionView.value.messages.find((m) => m.id === event.messageId)
      if (target && target.kind === 'text' && target.role === 'assistant') {
        // 已有占位/累积中的消息：追加思考文本
        sessionView.value = {
          ...sessionView.value,
          messages: sessionView.value.messages.map((m) =>
            m.id === event.messageId && m.kind === 'text' && m.role === 'assistant'
              ? { ...m, reasoning: (m.reasoning ?? '') + event.text }
              : m,
          ),
        }
      } else {
        // 首个 reasoning delta（思考先于正文）：创建 text 为空的占位 assistant 消息，正文 delta 到达后原位追加
        sessionView.value = {
          ...sessionView.value,
          messages: [...sessionView.value.messages, {
            id: event.messageId,
            role: 'assistant',
            kind: 'text',
            text: '',
            reasoning: event.text,
            createdAt: new Date().toISOString(),
          }],
        }
      }
      streamingMessageId.value = event.messageId
      return
    }

    if (event.type === 'file-changed') {
      // 实时合并（文件树自动刷新的 watch 源）；会话级权威清单在 run-finish 时整体覆盖。
      // lastFileChange 逐条记录原文，供内容面板判断是否重读当前打开的文件。
      applyFileChangeRecord(event.file)
      lastFileChange.value = event.file
      // 反馈队列（§7）：逐条保留供定位高亮消费，上限 30 防长任务堆积
      recentFileChanges.value = [
        ...recentFileChanges.value.slice(-29),
        { sessionId: event.sessionId, record: event.file },
      ]
      return
    }

    if (event.type === 'queue-updated') {
      queue.value = event.queue
      return
    }

    if (event.type === 'run-error') {
      // 以 driver 注册表真实状态为准：停止后立刻再发送时，pendingWake 再唤醒的新 run 的
      // run-start 可能先于旧 driver 的 run-error 到达，无条件置 false 会把新 run 的运行态打掉
      isRunning.value = isAgentRunActive(event.sessionId)
      isStopping.value = false
      streamingMessageId.value = null
      setRunStatus(event.error.message, 'error')
      return
    }

    if (event.type === 'run-finish') {
      // 同上：旧 driver 收尾事件晚到时，新 driver 可能已在注册表中（isRunning 保持 true）
      isRunning.value = isAgentRunActive(event.sessionId)
      isStopping.value = false
      streamingMessageId.value = null
      // 历史窗口兼容：run-finish 携带全量视图，按当前窗口起点切片，翻页成果不被冲掉
      const full = event.result.session
      const windowStart = historyStart.value
      sessionView.value = windowStart > 0
        ? { ...full, messages: full.messages.slice(windowStart) }
        : full
      changedFiles.value = event.result.session.changedFiles ?? []
      queue.value = event.result.session.queuedMessages ?? []
      // 状态栏常态显示会话级总数；本轮明细由 change-summary 面板承担
      const count = event.result.sessionChangedFileCount
      setRunStatus(count > 0 ? `本会话共修改 ${count} 个文件` : '本轮执行完成，未修改任何文件')

      // 仅当标题发生变化（典型：首轮发送后自动生成标题）才全量刷新列表，
      // 避免每轮对话都全量重扫文件系统。
      const entry = sessions.value.find((s) => s.sessionId === event.sessionId)
      if (entry && event.result.session.title && entry.title !== event.result.session.title) {
        void loadSessions(event.result.projectId)
      }
    }
  }

  // store 单例订阅全局事件总线（driver 后台跑，所有进展经此回流）
  subscribeAgentEvents(handleAgentEvent)

  /** 用户确认当前待确认的写操作，唤醒 Agent Loop 继续执行。 */
  function confirmWriteTool() {
    const confirmation = pendingConfirmation.value
    const active = activeSessionId.value
    if (!confirmation) {
      return
    }
    // respondConfirmation 内同步广播 confirmations-updated（含本次 resolve），map 随之更新；
    // expectedSessionId 自证会话归属（§8 按会话路由不串答），服务层校验不符则忽略
    respondAgentConfirmation(confirmation.id, true, active ?? undefined)
    setRunStatus('Agent 正在执行...', 'running')
  }

  /** 用户拒绝当前待确认的写操作，Agent 收到拒绝结果后可调整。 */
  function rejectWriteTool() {
    const confirmation = pendingConfirmation.value
    const active = activeSessionId.value
    if (!confirmation) {
      return
    }
    respondAgentConfirmation(confirmation.id, false, active ?? undefined)
    setRunStatus('Agent 正在执行...', 'running')
  }

  // ---------- 主动提问作答（卡片与输入框改道共用） ----------

  /** 重置当前提问的作答草稿（新问题到达 / 已作答时调用）。 */
  function resetQuestionDraft() {
    questionSelection.value = []
    questionText.value = ''
  }

  /**
   * 卡片候选项选择：单选替换、多选切换（保持候选项顺序，与提交校验一致）。
   * 未知标签静默忽略（候选项由问题定义，UI 不产生越界值）。
   */
  function toggleQuestionOption(label: string) {
    const question = pendingQuestion.value
    if (!question) {
      return
    }
    if (!question.multiSelect) {
      questionSelection.value = questionSelection.value.includes(label) ? [] : [label]
      return
    }
    const exists = questionSelection.value.includes(label)
    const next = exists
      ? questionSelection.value.filter((item) => item !== label)
      : [...questionSelection.value, label]
    // 按候选项原始顺序排序：多选完整集合的展示与提交顺序稳定
    const order = new Map((question.options ?? []).map((option, index) => [option.label, index]))
    questionSelection.value = next.sort(
      (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
    )
  }

  /**
   * 提交当前提问的回答（卡片提交 / 输入框改道共用）。
   * 校验失败（空回答等）不改等待态，错误文案进状态栏由用户补填。
   * respondQuestion 内同步广播 questions-updated 与补全 answer 的卡片消息。
   */
  function submitQuestionAnswer(input?: { text?: string }): boolean {
    const question = pendingQuestion.value
    if (!question || isSubmittingAnswer.value) {
      return false
    }
    const text = (input?.text ?? questionText.value).trim()
    isSubmittingAnswer.value = true
    try {
      respondAgentQuestion({
        questionId: question.questionId,
        selectedLabels: [...questionSelection.value],
        text,
      })
      // 同步收敛：作答草稿由 questions-updated/questionId 变化路径重置，此处兜底再清
      resetQuestionDraft()
      setRunStatus('Agent 正在执行...', 'running')
      return true
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '回答提交失败', 'error')
      return false
    } finally {
      isSubmittingAnswer.value = false
    }
  }

  /** 跳过当前提问：返回明确取消结局，Agent 在不获得答案的情况下调整后续处理。 */
  function skipCurrentQuestion() {
    const question = pendingQuestion.value
    if (!question) {
      return
    }
    skipAgentQuestion(question.questionId)
    resetQuestionDraft()
    setRunStatus('Agent 正在执行...', 'running')
  }

  /** 清空实时改动队列（切项目时由 ProjectView 调用，跨项目不串扰） */
  function clearRecentFileChanges() {
    recentFileChanges.value = []
  }

  return {
    changedFiles,
    lastFileChange,
    recentFileChanges,
    clearRecentFileChanges,
    queue,
    isRunning,
    isStopping,
    isLoadingSessions,
    messages,
    renderItems,
    pendingConfirmation,
    activeWriteConfirmation,
    pendingConfirmationCount,
    pendingConfirmationsBySession,
    sessionsWithPendingConfirmations,
    pendingQuestion,
    pendingQuestionsBySession,
    sessionsWithPendingQuestions,
    questionSelection,
    questionText,
    isSubmittingAnswer,
    sessionView,
    sessions,
    activeSessionId,
    runningSessionIds,
    historyStart,
    loadingOlder,
    hasMoreHistory,
    runStatus,
    runStatusType,
    hasSessionView,
    streamingMessageId,
    abortRun,
    archiveSession,
    compactActiveSession,
    confirmWriteTool,
    createNewSession,
    deleteSession,
    editQueuedMessage,
    initSessions,
    loadOlderHistory,
    loadSessions,
    rejectWriteTool,
    removeQueuedMessage,
    renameSession,
    selectSession,
    sendMessage,
    setRunStatus,
    skipCurrentQuestion,
    steerQueuedMessage,
    submitQuestionAnswer,
    unarchiveSession,
    toggleQuestionOption,
    toggleProcessGroup,
    sessionSaveFailures,
    dismissSessionSaveFailure,
  }
})
