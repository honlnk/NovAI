import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  respondConfirmation as respondAgentConfirmation,
  runTurn as runAgentTurn,
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
  RunAgentTurnInput,
  RunAgentTurnResult,
} from '@novai/core/services/types'

import { useProjectStore } from './project'

/** runStatus 的语义类型，供状态栏按类型上色，避免 UI 靠字符串猜测 */
export type RunStatusType = 'idle' | 'running' | 'error'

export const useChatStore = defineStore('chat', () => {
  const sessionView = ref<ChatSessionView | null>(null)
  const agentEvents = ref<AgentUiEvent[]>([])
  const changedFiles = ref<ChangedFileView[]>([])
  const runStatus = ref('还没有开始执行。')
  // runStatus 的语义类型，供状态栏按类型上色（idle 灰 / running 蓝 / error 红）
  const runStatusType = ref<RunStatusType>('idle')
  const isRunning = ref(false)
  // 用户已请求停止、正在等待当前工具执行完成
  const isStopping = ref(false)
  // 当前等待用户确认的写操作；Agent Loop 在此暂停
  const pendingConfirmation = ref<FileChangeConfirmationView | null>(null)

  // 历史会话列表（对话分类面板渲染），按 updatedAt 降序
  const sessions = ref<ChatSessionSummaryView[]>([])
  // 当前激活会话 id（高亮 + runTurn 路由用）
  const activeSessionId = ref<string | null>(null)
  const isLoadingSessions = ref(false)

  // 当前运行持有的停止控制器；仅 isRunning 期间存在
  let activeAbortController: AbortController | null = null

  const hasSessionView = computed(() => sessionView.value !== null)
  const messages = computed<ChatMessageView[]>(() => sessionView.value?.messages ?? [])

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

  /** 切换到指定历史会话：加载其完整消息体并设为激活。 */
  async function selectSession(projectId: string, sessionId: string): Promise<ChatSessionView | null> {
    const view = await getAgentSession(projectId, sessionId)
    if (!view) {
      return null
    }

    sessionView.value = view
    activeSessionId.value = sessionId
    // 切换会话时清空上一轮的运行态残留，避免跨会话串扰
    agentEvents.value = []
    changedFiles.value = []
    return view
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

  async function runServiceTurn(
    input: Omit<RunAgentTurnInput, 'sessionId' | 'onEvent'> & {
      onEvent?: (event: AgentUiEvent) => void
    },
  ): Promise<RunAgentTurnResult> {
    if (!sessionView.value) {
      throw new Error('没有活跃的会话')
    }
    const currentSession = sessionView.value
    // 记录本轮前标题，用于 finally 判断是否需要刷新列表（首轮会自动生成标题）
    const titleBeforeTurn = currentSession.title

    agentEvents.value = []
    changedFiles.value = []
    setRunStatus('正在执行本轮 Agent...', 'running')
    isRunning.value = true
    isStopping.value = false

    // 每轮新建 controller，signal 透传到 core Agent Loop
    activeAbortController = new AbortController()

    try {
      const result = await runAgentTurn({
        ...input,
        sessionId: currentSession.sessionId,
        signal: activeAbortController.signal,
        onEvent(event) {
          handleAgentEvent(event)
          input.onEvent?.(event)
        },
      })

      sessionView.value = result.session
      changedFiles.value = result.changedFiles
      setRunStatus(
        result.changedFiles.length > 0
          ? `本轮执行完成，变更 ${result.changedFiles.length} 个文件`
          : '本轮执行完成，未修改任何文件',
      )

      return result
    } catch (error) {
      setRunStatus(error instanceof Error ? error.message : '执行会话失败', 'error')
      throw error
    } finally {
      isRunning.value = false
      isStopping.value = false
      activeAbortController = null
      // 仅当标题发生变化（典型：首轮发送后自动生成标题）才全量刷新列表，
      // 避免每轮对话都全量重扫文件系统。updatedAt 的时间戳显示精度可接受滞后。
      const titleAfterTurn = sessionView.value?.title
      if (titleAfterTurn && titleAfterTurn !== titleBeforeTurn) {
        void loadSessions(currentSession.projectId)
      }
    }
  }

  /** 用户点击停止：中断当前模型流式请求，Agent Loop 会在边界优雅结束。 */
  function abortRun() {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
      // 立即进入「停止中」态：UI 反馈 + 等待当前工具完成
      isStopping.value = true
      setRunStatus('已请求停止，等待当前工具执行完成…', 'running')
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

  function handleAgentEvent(event: AgentUiEvent) {
    agentEvents.value = [...agentEvents.value, event]

    if (event.type === 'run-start') {
      setRunStatus('Agent 正在执行...', 'running')
      return
    }

    if (event.type === 'message' && sessionView.value) {
      sessionView.value = {
        ...sessionView.value,
        messages: [...sessionView.value.messages, event.message],
      }
      return
    }

    if (event.type === 'file-changed') {
      changedFiles.value = [...changedFiles.value, event.file]
      return
    }

    if (event.type === 'confirmation-required') {
      pendingConfirmation.value = event.request
      setRunStatus('等待确认写入操作…')
      return
    }

    if (event.type === 'run-error') {
      setRunStatus(event.error.message, 'error')
      return
    }

    if (event.type === 'run-finish') {
      sessionView.value = event.result.session
      changedFiles.value = event.result.changedFiles
      setRunStatus(
        event.result.changedFiles.length > 0
          ? `本轮执行完成，变更 ${event.result.changedFiles.length} 个文件`
          : '本轮执行完成，未修改任何文件',
      )
    }
  }

  async function sendMessage(text: string, quote?: string) {
    if (!sessionView.value) {
      throw new Error('没有活跃的会话')
    }

    // 把当前打开的文件路径作为隐式上下文传入，供 Agent 工具约束（如「只改当前文件」）解析使用。
    const projectStore = useProjectStore()
    const activeFilePath = projectStore.activeFile?.path
    return runServiceTurn({
      projectId: sessionView.value.projectId,
      instruction: text,
      quote,
      activeFilePath,
    })
  }

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
    agentEvents,
    changedFiles,
    isRunning,
    isStopping,
    isLoadingSessions,
    messages,
    pendingConfirmation,
    sessionView,
    sessions,
    activeSessionId,
    runStatus,
    runStatusType,
    hasSessionView,
    abortRun,
    confirmWriteTool,
    createNewSession,
    deleteSession,
    initSessions,
    loadSessions,
    rejectWriteTool,
    renameSession,
    runServiceTurn,
    selectSession,
    sendMessage,
    setRunStatus,
  }
})
