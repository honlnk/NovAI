<script setup lang="ts">
import { computed } from 'vue'

import Tooltip from '../ui/Tooltip.vue'
import { useIndexStore, getIndexStatusDotClass, getIndexStatusLabel } from '../../stores/index'
import type { IndexStatusView } from '@novai/core/services/types'

/**
 * 底部常驻 RAG 索引状态栏。
 *
 * - 随项目激活时由 ProjectView 注入 projectId 并触发 init
 * - 索引状态变化（要素写入标 stale / 重建完成）通过事件总线自动反映
 * - stale / error 可点击触发增量重建（省 API：未变文件复用旧向量）
 */
const props = defineProps<{
  projectId: string
}>()

const indexStore = useIndexStore()

const status = computed<IndexStatusView | null>(() => indexStore.status)
const isBusy = computed(() => indexStore.isBusy)

/** 主文案：状态 + 项数。 */
const label = computed(() => {
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

function handleClick() {
  if (!actionable.value) {
    return
  }
  indexStore.rebuild(props.projectId)
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
    class="flex h-7 shrink-0 items-center gap-2 border-t border-gray-200 bg-gray-50 px-3 text-xs text-gray-600"
  >
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
        @click="handleClick"
      >
        <span :class="['h-2 w-2 rounded-full', dotClass]" />
        <span>{{ label }}</span>
      </button>
    </Tooltip>

    <span v-if="indexStore.errorMessage" class="text-red-500">{{ indexStore.errorMessage }}</span>
  </div>
</template>
