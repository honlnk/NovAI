import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  respondConfirmation as respondAgentConfirmation,
  runTurn as runAgentTurn,
} from '@novai/core/services/agent-service'

import type {
  AgentUiEvent,
  ChangedFileView,
  ChatMessageView,
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

  // 当前运行持有的停止控制器；仅 isRunning 期间存在
  let activeAbortController: AbortController | null = null

  const hasSessionView = computed(() => sessionView.value !== null)
  const messages = computed<ChatMessageView[]>(() => sessionView.value?.messages ?? [])

  async function ensureSessionView(projectId: string) {
    if (!sessionView.value || sessionView.value.projectId !== projectId) {
      sessionView.value = await createAgentSession(projectId)
    }

    return sessionView.value
  }

  async function runServiceTurn(
    input: Omit<RunAgentTurnInput, 'sessionId' | 'onEvent'> & {
      onEvent?: (event: AgentUiEvent) => void
    },
  ): Promise<RunAgentTurnResult> {
    const currentSession = await ensureSessionView(input.projectId)

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

  async function createSession(projectId: string) {
    return ensureSessionView(projectId)
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
    messages,
    pendingConfirmation,
    sessionView,
    runStatus,
    hasSessionView,
    abortRun,
    confirmWriteTool,
    createSession,
    ensureSessionView,
    rejectWriteTool,
    sendMessage,
    runServiceTurn,
    setRunStatus,
  }
})
