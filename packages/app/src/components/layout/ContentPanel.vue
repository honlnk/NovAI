<script setup lang="ts">
import { ref } from 'vue'
import type { FileContentView } from '@novai/core/services/types'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

defineProps<{
  isOpen: boolean
  file: FileContentView | null
}>()

const emit = defineEmits<{
  close: []
}>()

const viewMode = ref<'preview' | 'raw'>('preview')

function toggleViewMode() {
  viewMode.value = viewMode.value === 'preview' ? 'raw' : 'preview'
}

function getLanguageLabel(format: string) {
  switch (format) {
    case 'markdown': return 'Markdown'
    case 'json': return 'JSON'
    default: return '文本'
  }
}

function shouldRenderMarkdown(format: string) {
  return format === 'markdown'
}
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
      'flex shrink-0 flex-col border-l border-gray-200 bg-white transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50',
      isOpen ? 'w-80' : 'w-0 overflow-hidden',
      isOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full',
    ]"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="truncate text-sm font-semibold text-gray-800">
          {{ file ? file.name : '内容预览' }}
        </h2>
        <span v-if="file" class="shrink-0 text-xs text-gray-500">
          {{ getLanguageLabel(file.format) }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <!-- 预览/原始切换 -->
        <button
          v-if="file"
          class="rounded-lg px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100"
          @click="toggleViewMode"
        >
          {{ viewMode === 'preview' ? '原始' : '预览' }}
        </button>
        <button
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:hidden"
          @click="emit('close')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
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
      <div v-else-if="file" class="space-y-3">
        <!-- 预览模式 -->
        <div v-if="viewMode === 'preview'" class="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <MarkdownRenderer v-if="shouldRenderMarkdown(file.format)" :content="file.content" />
          <pre v-else class="whitespace-pre-wrap text-sm text-gray-800">{{ file.content }}</pre>
        </div>

        <!-- 原始模式 -->
        <div v-else class="rounded-lg border border-gray-200 bg-gray-900 p-4">
          <pre class="whitespace-pre-wrap font-mono text-sm text-gray-100">{{ file.content }}</pre>
        </div>

        <!-- 文件信息 -->
        <div class="flex items-center justify-between text-xs text-gray-500">
          <span>{{ file.path }}</span>
          <span v-if="file.updatedAt">{{ new Date(file.updatedAt).toLocaleString('zh-CN') }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>
