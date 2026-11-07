<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'
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
    <AppIcon name="file-text" :size="14" class="h-3.5 w-3.5 shrink-0" />
    <span class="shrink-0 font-medium">{{ fileName }}</span>
    <span class="truncate">"{{ text }}"</span>
    <button
      type="button"
      class="flex shrink-0 items-center justify-center rounded p-0.5 text-blue-400 transition-colors hover:bg-blue-100 hover:text-blue-600"
      title="移除引用"
      @click="emit('remove')"
    >
      <AppIcon name="x" :size="14" class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
