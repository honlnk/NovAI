<script setup lang="ts">
import { onMounted, ref } from 'vue'

import type { FileChangeConfirmationView } from '@novai/core/services/types'

import TakeoverStopButton from './TakeoverStopButton.vue'

/**
 * 结构性写操作的输入区接管（交互优化计划 §8）：重命名/删除请求在原输入卡片位置
 * 紧凑接管——中性面板、细分隔线，不用大面积黄色/蓝色卡片。普通编辑器保持挂载但
 * 暂时隐藏（草稿保留），队列、停止和会话切换不受影响。
 *
 * 键盘（§8）：无编辑焦点时 Enter 允许一次、Escape 拒绝；焦点在按钮上时原生键盘
 * 行为优先（不重复触发）。
 */
const props = defineProps<{
  confirmation: FileChangeConfirmationView
}>()

const emit = defineEmits<{
  confirm: []
  reject: []
}>()

const takeoverRef = ref<HTMLDivElement | null>(null)

onMounted(() => {
  takeoverRef.value?.focus()
})

function handleKeydown(event: KeyboardEvent) {
  // 焦点在按钮等原生控件上时，交给原生键盘行为（避免 Enter 双触发）
  if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') {
    return
  }
  if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    emit('confirm')
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('reject')
  }
}
</script>

<template>
  <div
    ref="takeoverRef"
    class="chat-input-card outline-none"
    tabindex="-1"
    role="group"
    :aria-label="props.confirmation.title"
    @keydown="handleKeydown"
  >
    <div class="flex items-start gap-2.5 p-3">
      <!-- 图标：重命名箭头 / 删除垃圾桶（中性灰，不用大色块） -->
      <svg
        v-if="props.confirmation.confirmation.kind === 'rename'"
        class="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>
      <svg v-else class="mt-0.5 h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>

      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-gray-700">
          {{ props.confirmation.title }}
          <span
            v-if="props.confirmation.agentLabel"
            class="ml-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] font-normal text-gray-500"
          >{{ props.confirmation.agentLabel }}</span>
        </p>
        <p class="mt-0.5 text-xs text-gray-500">{{ props.confirmation.summary }}</p>

        <!-- 重命名：原名 → 目标名 + 影响说明（§8 展示原名、目标名与影响） -->
        <div
          v-if="props.confirmation.confirmation.kind === 'rename'"
          class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs"
        >
          <code class="rounded bg-gray-50 px-1.5 py-0.5 text-gray-700">{{ props.confirmation.confirmation.fromPath }}</code>
          <span class="text-gray-400">→</span>
          <code class="rounded bg-gray-50 px-1.5 py-0.5 text-gray-700">{{ props.confirmation.confirmation.toPath }}</code>
          <span class="text-gray-400">重命名后旧路径不再可用。</span>
        </div>

        <!-- 删除：路径 + 去向说明（§8 明确回收站或永久删除的后果） -->
        <p
          v-else-if="props.confirmation.confirmation.kind === 'delete'"
          class="mt-1.5 text-xs text-gray-500"
        >
          文件 <code class="rounded bg-gray-50 px-1.5 py-0.5 text-gray-700">{{ props.confirmation.confirmation.path }}</code> 将移入回收站（不永久删除），可在回收站恢复。
        </p>

        <p class="mt-1.5 text-[11px] text-gray-400">Enter 同意 · Escape 拒绝</p>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <!-- 停止仍可用（§8）：接管期间普通工具行隐藏，停止入口随面板保留 -->
        <TakeoverStopButton />
        <button
          type="button"
          class="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          @click="emit('reject')"
        >拒绝</button>
        <button
          type="button"
          class="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-700"
          @click="emit('confirm')"
        >同意执行</button>
      </div>
    </div>
  </div>
</template>
