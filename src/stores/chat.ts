import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { createChatSession } from '../core/chat/session'
import { deriveChatTargetFromPath } from '../core/chat/target'

import type { ChatSessionState, ChatTargetContext } from '../types/chat'

export const useChatStore = defineStore('chat', () => {
  const session = ref<ChatSessionState | null>(null)
  const runStatus = ref('还没有开始执行。')
  const defaultTarget = ref<ChatTargetContext | null>(null)

  const hasSession = computed(() => session.value !== null)
  const currentTarget = computed(() => session.value?.currentTarget ?? defaultTarget.value)

  function ensureSession(projectId: string) {
    if (!session.value || session.value.projectId !== projectId) {
      session.value = createChatSession(projectId)
      session.value.currentTarget = defaultTarget.value
    }

    return session.value
  }

  function setSession(nextSession: ChatSessionState) {
    session.value = nextSession
  }

  function syncDefaultTarget(projectId?: string, activeFilePath?: string | null) {
    defaultTarget.value = deriveChatTargetFromPath(activeFilePath)

    if (projectId) {
      ensureSession(projectId)
    }

    if (session.value) {
      session.value.currentTarget = defaultTarget.value
    }
  }

  function resetSession(projectId?: string) {
    session.value = projectId ? createChatSession(projectId) : null
    if (session.value) {
      session.value.currentTarget = defaultTarget.value
    }
    if (!projectId) {
      defaultTarget.value = null
    }
    runStatus.value = '还没有开始执行。'
  }

  function setRunStatus(nextStatus: string) {
    runStatus.value = nextStatus
  }

  return {
    session,
    runStatus,
    hasSession,
    currentTarget,
    defaultTarget,
    ensureSession,
    setSession,
    syncDefaultTarget,
    resetSession,
    setRunStatus,
  }
})
