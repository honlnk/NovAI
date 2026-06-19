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

export const useChatStore = defineStore('chat', () => {
  const sessionView = ref<ChatSessionView | null>(null)
  const agentEvents = ref<AgentUiEvent[]>([])
  const changedFiles = ref<ChangedFileView[]>([])
  const runStatus = ref('还没有开始执行。')
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

    return createNewSession(projectId)
  }

  /** 拉取并刷新历史会话列表，同步当前激活 id。 */
  async function loadSessions(projectId: string) {
    isLoadingSessions.value = true
    try {
      sessions.value = await listAgentSessions(projectId)
      // 列表里已不存在当前激活会话时清空（例如被删除）
      if (activeSessionId.value && !sessions.value.some((s) => s.sessionId === activeSessionId.value)) {
        activeSessionId.value = null
      }
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

  /** 新建会话：创建 + 激活 + 刷新列表。 */
  async function createNewSession(projectId: string): Promise<ChatSessionView> {
    const view = await createAgentSession(projectId)
    sessionView.value = view
    activeSessionId.value = view.sessionId
    await loadSessions(projectId)
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

  /** 删除会话；若删的是当前激活会话，则切到列表第一条或新建。 */
  async function deleteSession(projectId: string, sessionId: string): Promise<void> {
    await deleteAgentSession(projectId, sessionId)
    await loadSessions(projectId)

    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await selectSession(projectId, sessions.value[0].sessionId)
      } else {
        await createNewSession(projectId)
      }
    }
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

    agentEvents.value = []
    changedFiles.value = []
    runStatus.value = '正在执行本轮 Agent...'
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
      runStatus.value = result.changedFiles.length > 0
        ? `本轮执行完成，变更 ${result.changedFiles.length} 个文件`
        : '本轮执行完成，未修改任何文件'

      return result
    } catch (error) {
      runStatus.value = error instanceof Error ? error.message : '执行会话失败'
      throw error
    } finally {
      isRunning.value = false
      isStopping.value = false
      activeAbortController = null
      // 刷新历史列表（捕获首轮后的自动标题更新与 updatedAt 变化）
      void loadSessions(currentSession.projectId)
    }
  }

  /** 用户点击停止：中断当前模型流式请求，Agent Loop 会在边界优雅结束。 */
  function abortRun() {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
      // 立即进入「停止中」态：UI 反馈 + 等待当前工具完成
      isStopping.value = true
      runStatus.value = '已请求停止，等待当前工具执行完成…'
    }
  }

  function setRunStatus(nextStatus: string) {
    runStatus.value = nextStatus
  }

  function handleAgentEvent(event: AgentUiEvent) {
    agentEvents.value = [...agentEvents.value, event]

    if (event.type === 'run-start') {
      runStatus.value = 'Agent 正在执行...'
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
      runStatus.value = '等待确认写入操作…'
      return
    }

    if (event.type === 'run-error') {
      runStatus.value = event.error.message
      return
    }

    if (event.type === 'run-finish') {
      sessionView.value = event.result.session
      changedFiles.value = event.result.changedFiles
      runStatus.value = event.result.changedFiles.length > 0
        ? `本轮执行完成，变更 ${event.result.changedFiles.length} 个文件`
        : '本轮执行完成，未修改任何文件'
    }
  }

  async function sendMessage(text: string, quote?: string) {
    if (!sessionView.value) {
      throw new Error('没有活跃的会话')
    }

    return runServiceTurn({
      projectId: sessionView.value.projectId,
      instruction: text,
      quote,
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
    runStatus.value = 'Agent 正在执行...'
  }

  /** 用户拒绝当前待确认的写操作，Agent 收到拒绝结果后可调整。 */
  function rejectWriteTool() {
    const confirmation = pendingConfirmation.value
    if (!confirmation) {
      return
    }
    pendingConfirmation.value = null
    respondAgentConfirmation(confirmation.id, false)
    runStatus.value = 'Agent 正在执行...'
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
