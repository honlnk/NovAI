<script setup lang="ts">
import { computed } from 'vue'

import Tooltip from '../ui/Tooltip.vue'
import { useIndexStore, getIndexStatusDotClass, getIndexStatusLabel } from '../../stores/index'
import type { RunStatusType } from '../../stores/chat'
import type { IndexStatusView } from '@novai/core/services/types'

/**
 * 底部常驻项目状态栏。
 *
 * 三段式布局（h-7 矮栏，与 VS Code 风格一致）：
 * - 左：RAG 索引状态（项目层，慢变）。stale/error 可点击触发增量重建。
 * - 左：当前激活场景提示词（项目层）。无壳内联样式，点 × 关闭。
 * - 右：本轮 Agent 执行状态（会话层，瞬时）。按 type 上色（idle/running/error）。
 *
 * - 随项目激活时由 ProjectView 注入 projectId 并触发 init
 * - 索引状态变化（要素写入标 stale / 重建完成）通过事件总线自动反映
 */
const props = defineProps<{
  projectId: string
  /** 当前激活场景的显示名（已去扩展名），null 表示未激活 */
  activeSceneName: string | null
  /** 本轮执行状态文案（来自 chatStore.runStatus） */
  runStatus: string
  /** runStatus 的语义类型，用于上色 */
  runStatusType: RunStatusType
}>()

const emit = defineEmits<{
  /** 关闭当前激活场景（走 changeScene(null)） */
  clearScene: []
}>()

const indexStore = useIndexStore()

const status = computed<IndexStatusView | null>(() => indexStore.status)
const isBusy = computed(() => indexStore.isBusy)

/** 索引主文案：状态 + 项数。 */
const indexLabel = computed(() => {
  if (!status.value) {
    return '索引未初始化'
  }

  const base = getIndexStatusLabel(status.value)
  const count = indexStore.documentCount

  if (status.value === 'building' || status.value === 'rebuilding') {
    return `${base}…`
  }
  if (status.value === 'empty') {
    return base
  }
  return `${base} · ${count} 项`
})

/** 点击态：仅 stale/error 且非 busy 时可触发重建。 */
const actionable = computed(
  () => !isBusy.value && (status.value === 'stale' || status.value === 'error'),
)

const dotClass = computed(() => {
  if (isBusy.value) {
    return 'bg-blue-500 animate-pulse'
  }
  return status.value ? getIndexStatusDotClass(status.value) : 'bg-gray-300'
})

/** tooltip 详情：构建时间 / 错误原因。 */
const tooltipText = computed(() => {
  const meta = indexStore.indexMeta
  if (!meta) {
    return '当前项目还没有索引记录'
  }

  const parts: string[] = []
  if (meta.lastBuildAt) {
    parts.push(`上次构建：${formatTime(meta.lastBuildAt)}`)
  }
  if (meta.embeddingModel) {
    parts.push(`模型：${meta.embeddingModel}`)
  }
  if (status.value === 'stale' || status.value === 'error') {
    parts.push(meta.lastError ?? '点击重新构建索引')
  }
  return parts.join('\n') || '点击查看索引详情'
})

/** runStatus 按 type 上色：error 红、running 蓝、idle 灰。 */
const runStatusClass = computed(() => {
  switch (props.runStatusType) {
    case 'error':
      return 'text-red-500'
    case 'running':
      return 'text-blue-500'
    default:
      return 'text-gray-500'
  }
})

function handleIndexClick() {
  if (!actionable.value) {
    return
  }
  indexStore.rebuild(props.projectId)
}

function handleClearScene() {
  emit('clearScene')
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}
</script>

<template>
  <div
    class="flex h-7 shrink-0 items-center gap-3 border-t border-gray-200 bg-gray-50 px-3 text-xs text-gray-600"
  >
    <!-- 左侧：项目层状态（索引 + 场景） -->
    <div class="flex min-w-0 items-center gap-3">
      <!-- 索引状态 -->
      <Tooltip
        :text="tooltipText"
        preferred-placement="top"
        multiline
      >
        <button
          type="button"
          class="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors"
          :class="actionable ? 'cursor-pointer hover:bg-gray-200 hover:text-gray-900' : 'cursor-default'"
          :disabled="!actionable"
          @click="handleIndexClick"
        >
          <span :class="['h-2 w-2 rounded-full', dotClass]" />
          <span>{{ indexLabel }}</span>
        </button>
      </Tooltip>

      <!-- 当前激活场景（紧凑内联，无壳）：📍 名称 × -->
      <div
        v-if="activeSceneName"
        class="flex min-w-0 items-center gap-1 text-green-600"
        title="当前场景提示词"
      >
        <span class="shrink-0">📍</span>
        <span class="truncate font-medium">{{ activeSceneName }}</span>
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-green-500 transition-colors hover:bg-green-200 hover:text-green-800"
          title="关闭场景"
          @click="handleClearScene"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 右侧：会话层执行状态 -->
    <div class="ml-auto flex items-center gap-2">
      <span v-if="indexStore.errorMessage" class="text-red-500">{{ indexStore.errorMessage }}</span>
      <span
        class="truncate"
        :class="runStatusClass"
        :title="runStatus"
      >{{ runStatus }}</span>
    </div>
  </div>
</template>
