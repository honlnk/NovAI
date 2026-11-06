<script setup lang="ts">
/**
 * 内容面板统一头部（布局统一计划 §2.1/§4.1）：高度、留白、边框与移动端关闭入口
 * 统一承载，普通文件 / 计划详情 / 新建计划三种内容只填充左右两侧的内容。
 */
const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <header class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <slot name="leading" />
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
      <button
        aria-label="关闭内容面板"
        class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:hidden"
        @click="emit('close')"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </header>
</template>
