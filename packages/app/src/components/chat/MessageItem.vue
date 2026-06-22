<script setup lang="ts">
import type { ChatMessageView } from '@novai/core/services/types'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

defineProps<{
  message: ChatMessageView
}>()

function formatTime(dateStr: string) {
  const date = new Date(dateStr)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <!-- 用户消息 -->
  <div
    v-if="message.role === 'user'"
    class="flex justify-end gap-3"
  >
    <div class="flex max-w-[80%] flex-row-reverse items-start gap-3">
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
      <div class="rounded-lg rounded-tr-none bg-blue-600 px-4 py-2.5">
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
  </div>

  <!-- AI 消息 -->
  <div
    v-else-if="message.role === 'assistant'"
    class="flex justify-start gap-3"
  >
    <div class="flex max-w-[80%] items-start gap-3">
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      </div>
      <div class="rounded-lg rounded-tl-none bg-gray-100 px-4 py-2.5">
        <MarkdownRenderer :content="message.text" />
        <p class="mt-1 text-xs text-gray-500">{{ formatTime(message.createdAt) }}</p>
      </div>
    </div>
  </div>

  <!-- 系统消息（工具调用、工具结果、错误等） -->
  <div
    v-else-if="message.role === 'system'"
    class="flex justify-center"
  >
    <div
      :class="[
        'max-w-[90%] rounded-lg px-4 py-2.5',
        message.kind === 'error' ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-600',
      ]"
    >
      <!-- 工具调用 -->
      <div v-if="message.kind === 'tool-call'" class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span class="text-sm font-medium">调用工具：{{ message.toolName }}</span>
      </div>

      <!-- 工具结果 -->
      <div v-else-if="message.kind === 'tool-result'" class="flex items-center gap-2">
        <svg
          :class="[
            'h-4 w-4 shrink-0',
            message.ok ? 'text-green-500' : 'text-red-500',
          ]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            v-if="message.ok"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
          <path
            v-else
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span class="text-sm">{{ message.text }}</span>
      </div>

      <!-- 上下文压缩摘要 -->
      <div v-else-if="message.kind === 'context-summary'" class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        <span class="text-sm text-gray-500">{{ message.text }}</span>
      </div>

      <!-- 错误消息 -->
      <div v-else-if="message.kind === 'error'" class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-sm">{{ message.text }}</span>
      </div>

      <!-- 其他系统消息 -->
      <div v-else>
        <p class="text-sm">{{ message.text }}</p>
      </div>
    </div>
  </div>
</template>
