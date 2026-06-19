<script setup lang="ts">
import { ref } from 'vue'
import type { ChatSessionSummaryView } from '@novai/core/services/types'

defineProps<{
  sessions: ChatSessionSummaryView[]
  activeSessionId: string | null
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  rename: [sessionId: string, title: string]
  remove: [sessionId: string]
}>()

/** 当前正在内联重命名的 sessionId；null 表示无 */
const renamingId = ref<string | null>(null)
const renameDraft = ref('')

function startRename(session: ChatSessionSummaryView) {
  renamingId.value = session.sessionId
  renameDraft.value = session.title
}

function commitRename(sessionId: string) {
  const title = renameDraft.value.trim()
  renamingId.value = null
  if (title) {
    emit('rename', sessionId, title)
  }
}

function cancelRename() {
  renamingId.value = null
}

function confirmRemove(session: ChatSessionSummaryView) {
  // 删除不可撤销，弹原生 confirm 二次确认
  if (window.confirm(`确定删除对话「${session.title}」吗？此操作不可撤销。`)) {
    emit('remove', session.sessionId)
  }
}

/** 相对时间：今天显示 HH:mm，今年显示 MM-DD，更早显示完整日期 */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  if (sameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return date.toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">对话</h2>
      <button
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        title="开始新对话"
        @click="emit('create')"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span>新对话</span>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 空状态 -->
      <div v-if="sessions.length === 0" class="px-2 py-8 text-center">
        <svg class="mx-auto mb-3 h-10 w-10 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <p class="mb-1 text-sm text-gray-400">还没有对话</p>
        <p class="text-xs text-gray-500">点击「新对话」开始创作</p>
      </div>

      <!-- 会话列表 -->
      <ul v-else class="space-y-0.5">
        <li v-for="session in sessions" :key="session.sessionId" class="group relative">
          <!-- 重命名态：内联输入框 -->
          <div
            v-if="renamingId === session.sessionId"
            class="flex items-center rounded-md bg-white/10 px-2 py-1.5"
          >
            <input
              v-model="renameDraft"
              class="min-w-0 flex-1 rounded bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
              placeholder="会话标题"
              @keydown.enter="commitRename(session.sessionId)"
              @keydown.esc="cancelRename"
              @blur="commitRename(session.sessionId)"
            >
          </div>

          <!-- 展示态：会话卡片 -->
          <button
            v-else
            :class="[
              'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
              session.sessionId === activeSessionId
                ? 'bg-white/15 text-white'
                : 'text-gray-300 hover:bg-white/10 hover:text-white',
            ]"
            @click="emit('select', session.sessionId)"
          >
            <svg class="mt-0.5 h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" />
            </svg>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ session.title }}</p>
              <p class="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                <span>{{ formatRelativeTime(session.updatedAt) }}</span>
                <span>·</span>
                <span>{{ session.messageCount }} 条</span>
              </p>
            </div>
          </button>

          <!-- hover 操作按钮（重命名/删除） -->
          <div
            v-if="renamingId !== session.sessionId"
            class="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <button
              class="rounded p-1 text-gray-400 hover:bg-white/15 hover:text-white"
              title="重命名"
              @click.stop="startRename(session)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              class="rounded p-1 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
              title="删除"
              @click.stop="confirmRemove(session)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
