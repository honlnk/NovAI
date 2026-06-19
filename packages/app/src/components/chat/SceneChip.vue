<script setup lang="ts">
/**
 * 场景激活态 chip（R4）。
 *
 * 与引用 SelectionChip 区分：📍 图标 + 绿色调，表示当前对话应用的场景提示词。
 * 常驻于输入框上方，点 × 关闭场景（走 changeScene(null)）。
 */
defineProps<{
  sceneName: string
}>()

const emit = defineEmits<{
  remove: []
}>()
</script>

<template>
  <div
    class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-2 py-1 text-xs text-green-700"
  >
    <span class="shrink-0">📍</span>
    <span class="truncate font-medium">{{ sceneName }}</span>
    <button
      type="button"
      class="shrink-0 rounded p-0.5 text-green-500 transition-colors hover:bg-green-200 hover:text-green-800"
      title="关闭场景"
      @click="emit('remove')"
    >
      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
