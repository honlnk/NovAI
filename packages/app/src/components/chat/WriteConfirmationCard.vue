<script setup lang="ts">
import { computed } from 'vue'
import type { WriteConfirmationView } from '@novai/core/services/types'

/**
 * 写工具确认卡片（Agent Step 2/3）。
 *
 * Agent 在执行写工具前暂停，由该卡片展示操作预览（diff / 路径），
 * 用户确认后写入生效，拒绝则 Agent 收到拒绝结果并可调整。
 */
const props = defineProps<{
  confirmation: WriteConfirmationView
  toolName: string
  title: string
  summary: string
}>()

const emit = defineEmits<{
  confirm: []
  reject: []
}>()

const diffOldText = computed(() => props.confirmation.kind === 'edit' ? props.confirmation.oldText : '')
const diffNewText = computed(() => props.confirmation.kind === 'edit' ? props.confirmation.newText : '')

/** diff 文本过长时折叠，避免卡片撑爆对话区。 */
const MAX_DIFF_CHARS = 600
const oldPreview = computed(() => truncate(diffOldText.value, MAX_DIFF_CHARS))
const newPreview = computed(() => truncate(diffNewText.value, MAX_DIFF_CHARS))

function truncate(text: string, max: number) {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max)}…（共 ${text.length} 字符，已截断预览）`
}
</script>

<template>
  <div class="mx-auto mb-2 max-w-3xl rounded-lg border border-amber-200 bg-amber-50">
    <div class="p-4">
      <!-- 标题区 -->
      <div class="mb-3 flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
          />
        </svg>
        <p class="text-sm font-medium text-gray-700">{{ title }}</p>
      </div>

      <!-- 摘要 -->
      <p class="mb-3 text-xs text-gray-500">{{ summary }}</p>

      <!-- 新建文件：内容预览 -->
      <div v-if="confirmation.kind === 'create'" class="mb-3">
        <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-xs text-gray-700">{{ confirmation.content }}</pre>
      </div>

      <!-- 修改文件：old → new diff 预览 -->
      <div v-else-if="confirmation.kind === 'edit'" class="mb-3 space-y-2">
        <div>
          <p class="mb-1 text-xs font-medium text-red-500">原文（将被替换）</p>
          <pre class="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800">{{ oldPreview }}</pre>
        </div>
        <div>
          <p class="mb-1 text-xs font-medium text-green-600">新文本</p>
          <pre class="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-green-50 p-3 text-xs text-green-800">{{ newPreview }}</pre>
        </div>
      </div>

      <!-- 重命名：from → to -->
      <div v-else-if="confirmation.kind === 'rename'" class="mb-3 flex items-center gap-2 text-xs">
        <code class="rounded bg-white px-2 py-1 text-gray-700">{{ confirmation.fromPath }}</code>
        <svg class="h-3 w-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
        <code class="rounded bg-white px-2 py-1 text-gray-700">{{ confirmation.toPath }}</code>
      </div>

      <!-- 删除：路径 + 回收站说明 -->
      <div v-else-if="confirmation.kind === 'delete'" class="mb-3">
        <p class="text-xs text-gray-600">
          文件 <code class="rounded bg-white px-1.5 py-0.5 text-gray-700">{{ confirmation.path }}</code> 将移入回收站（不永久删除）。
        </p>
      </div>

      <!-- 操作按钮 -->
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-amber-100"
          @click="emit('reject')"
        >
          拒绝
        </button>
        <button
          type="button"
          class="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700"
          @click="emit('confirm')"
        >
          确认写入
        </button>
      </div>
    </div>
  </div>
</template>
