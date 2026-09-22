import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  respondConfirmation as respondAgentConfirmation,
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
} from '@novai/core/services/agent-service'

import type {
  AgentUiEvent,
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

/** runStatus 的语义类型，供状态栏按类型上色，避免 UI 靠字符串猜测 */
export type RunStatusType = 'idle' | 'running' | 'error'

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
  /** 收件箱队列快照（QueueDock 渲染用），由 queue-updated 事件同步、切换会话时从 view 重建 */
  const queue = ref<QueuedMessageView[]>([])
  const runStatus = ref('还没有开始执行。')
  // runStatus 的语义类型，供状态栏按类型上色（idle 灰 / running 蓝 / error 红）
  const runStatusType = ref<RunStatusType>('idle')
  // 事件驱动：run-start 置真、run-finish/run-error 置假（driver 后台跑，不再由单次 await 的 finally 控制）
  const isRunning = ref(false)
  // 用户已请求停止、正在等待当前工具执行完成
  const isStopping = ref(false)
  // 当前等待用户确认的写操作；Agent Loop 在此暂停
  const pendingConfirmation = ref<FileChangeConfirmationView | null>(null)
  // 当前正在流式输出的消息 id（供消息气泡显示「生成中」光标）；无流式消息时为 null
  const streamingMessageId = ref<string | null>(null)

  // 历史会话列表（对话分类面板渲染），按 updatedAt 降序
  const sessions = ref<ChatSessionSummaryView[]>([])
  // 当前激活会话 id（高亮 + 事件路由用）
  const activeSessionId = ref<string | null>(null)
  const isLoadingSessions = ref(false)

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
   * 拉取历史会话列表，有历史则激活最近一条，无历史则新建。
   * 取代旧的 ensureSessionView（后者只支持单会话）。
   */
  async function initSessions(projectId: string): Promise<ChatSessionView> {
    await loadSessions(projectId)

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
   * skipReload=true 时跳过内部全量刷新（调用方已确知列表状态，如 initSessions 走过 loadSessions、
   * 或 deleteSession 清空后），改为本地插入新会话摘要到列表头部。
   */
  async function createNewSession(
    projectId: string,
    options: { skipReload?: boolean } = {},
  ): Promise<ChatSessionView> {
    const view = await createAgentSession(projectId)
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
   * 发送入口：入队先于唤醒，立即返回（driver 在后台跑，进展经事件总线回流）。
   * - mode 'queue'：next-turn 排队（空闲时效果等同直接发送）；
   * - mode 'steer'：next-step 插话，下一 step 边界生效（仅运行中有意义）。
   * 返回是否入队成功：失败时 UI 负责把草稿填回输入框（dsh restoreFailedDrafts 简单版）。
   */
  async function sendMessage(
    text: string,
    quote?: string,
    mode: 'queue' | 'steer' = 'queue',
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
        activeFilePath: projectStore.activeFile?.path ?? null,
      })
      return true
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '发送失败', 'error')
      return false
    }
  }

  /** QueueDock 行内编辑排队消息；失败抛错由 UI toast。 */
  async function editQueuedMessage(id: string, text: string): Promise<void> {
    if (!sessionView.value) return
    await updateAgentQueuedMessage({
      projectId: sessionView.value.projectId,
      sessionId: sessionView.value.sessionId,
      id,
      action: { kind: 'edit', text },
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
    // 事件总线是全局的：只消费当前激活会话的事件（后台会话的 driver 仍在跑，UI 不跟随）
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

    if (event.type === 'file-changed') {
      // 实时合并（文件树自动刷新的 watch 源）；会话级权威清单在 run-finish 时整体覆盖。
      // lastFileChange 逐条记录原文，供内容面板判断是否重读当前打开的文件。
      applyFileChangeRecord(event.file)
      lastFileChange.value = event.file
      return
    }

    if (event.type === 'queue-updated') {
      queue.value = event.queue
      return
    }

    if (event.type === 'confirmation-required') {
      pendingConfirmation.value = event.request
      setRunStatus('等待确认写入操作…')
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
    if (!confirmation) {
      return
    }
    pendingConfirmation.value = null
    respondAgentConfirmation(confirmation.id, true)
    setRunStatus('Agent 正在执行...', 'running')
  }

  /** 用户拒绝当前待确认的写操作，Agent 收到拒绝结果后可调整。 */
  function rejectWriteTool() {
    const confirmation = pendingConfirmation.value
    if (!confirmation) {
      return
    }
    pendingConfirmation.value = null
    respondAgentConfirmation(confirmation.id, false)
    setRunStatus('Agent 正在执行...', 'running')
  }

  return {
    changedFiles,
    lastFileChange,
    queue,
    isRunning,
    isStopping,
    isLoadingSessions,
    messages,
    renderItems,
    pendingConfirmation,
    sessionView,
    sessions,
    activeSessionId,
    historyStart,
    loadingOlder,
    hasMoreHistory,
    runStatus,
    runStatusType,
    hasSessionView,
    streamingMessageId,
    abortRun,
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
    steerQueuedMessage,
    toggleProcessGroup,
  }
})
