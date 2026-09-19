<script setup lang="ts">
import type { ChatMessageView } from '@novai/core/services/types'

import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import TurnChangesPanel from './TurnChangesPanel.vue'

defineProps<{
  message: ChatMessageView
  /** 该消息正在流式输出中（渲染「生成中」光标） */
  streaming?: boolean
  /** change-summary：是否最新一轮（最新面板默认展开文件列表） */
  newestChangeSummary?: boolean
}>()

function formatTime(dateStr: string) {
  const date = new Date(dateStr)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <!-- 用户消息：右对齐气泡，去头像（dsh 风） -->
  <div
    v-if="message.role === 'user'"
    class="flex justify-end"
  >
    <div class="max-w-[80%] rounded-lg rounded-tr-none bg-blue-600 px-4 py-2.5">
      <!-- 引用块：选中内容作为独立引用展示在正文上方 -->
      <div
        v-if="message.quote"
        class="mb-2 border-l-2 border-blue-300 bg-blue-500/40 py-1 pl-2 pr-1"
      >
        <p class="whitespace-pre-wrap text-xs text-blue-100">{{ message.quote }}</p>
      </div>
      <p class="whitespace-pre-wrap text-sm text-white">{{ message.text }}</p>
      <p class="mt-1 text-right text-xs text-blue-200">{{ formatTime(message.createdAt) }}</p>
    </div>
  </div>

  <!-- AI 消息：全宽左对齐纯 markdown，不套气泡框（dsh 风） -->
  <div
    v-else-if="message.role === 'assistant' && message.kind === 'text'"
    class="w-full text-left"
  >
    <div class="text-sm leading-relaxed text-gray-800">
      <MarkdownRenderer :content="message.text" />
      <span
        v-if="streaming"
        class="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-gray-400 align-text-bottom"
        aria-label="正在生成"
      />
    </div>
  </div>

  <!-- 旧版完成总结（不再产生；旧会话按瘦行样式只读渲染） -->
  <div
    v-else-if="message.role === 'assistant' && message.kind === 'action-summary'"
    class="text-xs text-gray-400"
  >
    {{ message.text }}
  </div>

  <!-- 改动汇总面板（change-summary：本轮交付物，永不折叠进过程组） -->
  <TurnChangesPanel
    v-else-if="message.role === 'system' && message.kind === 'change-summary'"
    :message="message"
    :newest="newestChangeSummary"
  />

  <!-- 错误消息（永不折叠） -->
  <div
    v-else-if="message.role === 'system' && message.kind === 'error'"
    class="flex justify-center"
  >
    <div class="max-w-[90%] rounded-lg bg-red-50 px-4 py-2.5 text-red-800">
      <div class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-sm">{{ message.text }}</span>
      </div>
    </div>
  </div>

  <!-- 过程类系统消息（首条 user 之前的残留等，正常已进折叠组） -->
  <div
    v-else-if="message.role === 'system'"
    class="flex justify-center"
  >
    <div class="max-w-[90%] rounded-lg bg-gray-50 px-4 py-2.5 text-gray-600">
      <p class="text-sm">{{ message.text }}</p>
    </div>
  </div>
</template>
