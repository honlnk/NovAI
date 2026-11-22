<script setup lang="ts">
import { useChatStore } from '../../stores/chat'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 输入区接管（提问/重命名/删除）共用的停止按钮（§8「停止仍可用」）：接管期间普通
 * 编辑器工具行整体隐藏，停止入口随接管面板保留——等待确认/回答时用户仍可中止本轮。
 * 空闲时不渲染任何东西。实心停止方块 lucide 无对应实心图形，保留手绘。
 */
const chatStore = useChatStore()
</script>

<template>
  <button
    v-if="chatStore.isStopping"
    class="shrink-0 rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-400"
    title="正在停止…"
    disabled
  >
    <AppIcon name="loader-circle" :size="20" class="h-5 w-5 animate-spin" />
  </button>

  <button
    v-else-if="chatStore.isRunning"
    class="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
    title="停止运行"
    @click="chatStore.abortRun()"
  >
    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  </button>
</template>
