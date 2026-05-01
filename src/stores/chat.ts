import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createSession as createAgentSession,
  deriveTargetFromPath,
  runTurn as runAgentTurn,
} from '../services/agent-service'

import type {
  AgentUiEvent,
  ChangedFileView,
  ChatSessionView,
  ChatTargetView,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from '../services/types'

export const useChatStore = defineStore('chat', () => {
  const sessionView = ref<ChatSessionView | null>(null)
  const agentEvents = ref<AgentUiEvent[]>([])
  const changedFiles = ref<ChangedFileView[]>([])
  const runStatus = ref('还没有开始执行。')
  const defaultTarget = ref<ChatTargetView | null>(null)

  const hasSessionView = computed(() => sessionView.value !== null)
  const currentTarget = computed(() => defaultTarget.value)

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

  function syncDefaultTarget(projectId?: string, activeFilePath?: string | null) {
    void projectId
    defaultTarget.value = deriveTargetFromPath(activeFilePath)
  }

  function resetSession(projectId?: string) {
    sessionView.value = null
    agentEvents.value = []
    changedFiles.value = []
    if (!projectId) {
      defaultTarget.value = null
    }
    runStatus.value = '还没有开始执行。'
  }

  function setRunStatus(nextStatus: string) {
    runStatus.value = nextStatus
  }

  function handleAgentEvent(event: AgentUiEvent) {
    if (event.type !== 'assistant-delta') {
      agentEvents.value = [...agentEvents.value, event]
    }

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

    if (event.type === 'assistant-delta' && sessionView.value) {
      sessionView.value = {
        ...sessionView.value,
        currentDraftText: event.fullText,
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

  return {
    agentEvents,
    changedFiles,
    sessionView,
    runStatus,
    hasSessionView,
    currentTarget,
    defaultTarget,
    ensureSessionView,
    runServiceTurn,
    syncDefaultTarget,
    resetSession,
    setRunStatus,
  }
})
