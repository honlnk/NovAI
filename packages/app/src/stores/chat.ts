import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  runTurn as runAgentTurn,
} from '@novai/core/services/agent-service'

import type {
  AgentUiEvent,
  ChangedFileView,
  ChatMessageView,
  ChatSessionView,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from '@novai/core/services/types'

export const useChatStore = defineStore('chat', () => {
  const sessionView = ref<ChatSessionView | null>(null)
  const agentEvents = ref<AgentUiEvent[]>([])
  const changedFiles = ref<ChangedFileView[]>([])
  const runStatus = ref('还没有开始执行。')

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

    try {
      const result = await runAgentTurn({
        ...input,
        sessionId: currentSession.sessionId,
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

  async function sendMessage(text: string) {
    if (!sessionView.value) {
      throw new Error('没有活跃的会话')
    }

    return runServiceTurn({
      projectId: sessionView.value.projectId,
      instruction: text,
    })
  }

  return {
    agentEvents,
    changedFiles,
    messages,
    sessionView,
    runStatus,
    hasSessionView,
    createSession,
    ensureSessionView,
    sendMessage,
    runServiceTurn,
    setRunStatus,
  }
})
