<script setup lang="ts">
/**
 * 选中内容引用 chip。
 * 显示文件名 + 截断的选中文本，点 × 清除引用。
 * chip 内文本截断仅影响展示，实际发送的完整文本由父组件持有。
 */
defineProps<{
  fileName: string
  text: string
}>()

const emit = defineEmits<{
  remove: []
}>()
</script>

<template>
  <div
    class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700"
  >
    <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
    <span class="shrink-0 font-medium">{{ fileName }}</span>
    <span class="truncate">"{{ text }}"</span>
    <button
      type="button"
      class="flex shrink-0 items-center justify-center rounded p-0.5 text-blue-400 transition-colors hover:bg-blue-100 hover:text-blue-600"
      title="移除引用"
      @click="emit('remove')"
    >
      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
