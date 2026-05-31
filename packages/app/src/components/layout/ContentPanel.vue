<script setup lang="ts">
import type { FileContentView } from '@novai/core/services/types'

defineProps<{
  isOpen: boolean
  file: FileContentView | null
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <!-- 移动端遮罩 -->
  <div
    v-if="isOpen"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden"
    @click="emit('close')"
  />

  <!-- 内容面板 -->
  <aside
    :class="[
      'flex w-80 shrink-0 flex-col border-l border-gray-200 bg-white transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50',
      isOpen ? 'w-80' : 'w-0 overflow-hidden',
      isOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full',
    ]"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <h2 class="text-sm font-semibold text-gray-800">内容预览</h2>
      <button
        class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        @click="emit('close')"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-y-auto p-4">
      <!-- 空状态 -->
      <div v-if="!file" class="flex flex-col items-center justify-center py-16">
        <svg class="mb-4 h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="mb-1 text-sm font-medium text-gray-400">暂无内容</p>
        <p class="text-xs text-gray-400">点击文件或等待 AI 生成</p>
      </div>

      <!-- 文件内容 -->
      <div v-else>
        <div class="mb-3 flex items-center justify-between">
          <h3 class="truncate text-sm font-medium text-gray-800">{{ file.name }}</h3>
          <span class="text-xs text-gray-500">{{ file.format }}</span>
        </div>
        <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <pre class="whitespace-pre-wrap font-mono text-sm text-gray-800">{{ file.content }}</pre>
        </div>
      </div>
    </div>
  </aside>
</template>
