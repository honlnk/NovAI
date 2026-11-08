<script setup lang="ts">
import { computed } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import BoardPanel from '../card-board/BoardPanel.vue'

/**
 * 计划看板主面板：通用看板骨架（components/card-board/BoardPanel.vue）的计划
 * 领域装配——列口径（默认四常驻列 + 已搁置筛选）、卡片内容（计划名/摘要/时间）
 * 与空状态文案。布局与加载反馈约定见骨架组件注释。
 */
const props = defineProps<{
  board: {
    columns: Readonly<Record<PlanStatusView, readonly PlanCardSummaryView[]>>
    issues: readonly unknown[]
  } | null
  isLoading: boolean
  errorMessage: string
  selectedCardId: string | null
  showOnHold: boolean
  /** 左侧分类侧栏是否展开（开关图标状态与其他页面一致） */
  isSidebarOpen: boolean
  /** 右侧内容面板是否可见（计划详情/新建均算展开） */
  isContentPanelOpen: boolean
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  moveCard: [id: string, status: PlanStatusView, afterId: string | null]
  retryLoad: []
  toggleOnHold: []
  toggleSidebar: []
  toggleMobileSidebar: []
  toggleContentPanel: []
}>()

/** 看板列展示口径：默认四常驻列；开筛选后只显示已搁置列 */
const columns = computed(() => {
  if (!props.board) {
    return []
  }

  const entries = Object.entries(props.board.columns) as [PlanStatusView, PlanCardSummaryView[]][]
  return (props.showOnHold
    ? entries.filter(([status]) => status === 'on-hold')
    : entries.filter(([status]) => status !== 'on-hold')
  ).map(([status, cards]) => ({ key: status, label: PLAN_COLUMN_LABELS[status], cards }))
})

const totalCards = computed(() => {
  if (!props.board) {
    return 0
  }
  return (Object.values(props.board.columns) as PlanCardSummaryView[][])
    .reduce((total, cards) => total + cards.length, 0)
})

/** 骨架屏列数：与默认四常驻列一致（首载时还没有可跟随的筛选状态数据） */
const SKELETON_COLUMN_COUNT = 4

function onBoardMoveCard(id: string, columnKey: string, afterId: string | null) {
  emit('moveCard', id, columnKey as PlanStatusView, afterId)
}

function formatTime(iso: string): string {
  if (!iso) {
    return '未知时间'
  }
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
</script>

<template>
  <BoardPanel
    title="创作计划板"
    :total-cards="totalCards"
    :columns="columns"
    :skeleton-column-count="SKELETON_COLUMN_COUNT"
    :has-board-data="board !== null"
    :is-loading="isLoading"
    :error-message="errorMessage"
    :selected-card-id="selectedCardId"
    :is-sidebar-open="isSidebarOpen"
    :is-content-panel-open="isContentPanelOpen"
    empty-text="还没有计划。把准备安排的剧情、伏笔、灵感或待补设定记下来。"
    empty-create-label="新建一条计划"
    testid-prefix="plan"
    @open-create="emit('openCreate')"
    @open-card="emit('openCard', $event)"
    @move-card="(id, columnKey, afterId) => onBoardMoveCard(id, columnKey, afterId)"
    @retry-load="emit('retryLoad')"
    @toggle-sidebar="emit('toggleSidebar')"
    @toggle-mobile-sidebar="emit('toggleMobileSidebar')"
    @toggle-content-panel="emit('toggleContentPanel')"
  >
    <template #header-extra>
      <button
        :class="[
          'ml-1 shrink-0 rounded-md border px-2 py-1 text-xs transition-colors',
          showOnHold
            ? 'border-gray-900 bg-gray-900 text-white'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100',
        ]"
        aria-label="查看已搁置的卡片"
        @click="emit('toggleOnHold')"
      >
        已搁置
      </button>
    </template>

    <template #card-content="{ card }">
      <p class="text-sm font-medium text-gray-800">{{ card.title || '（无标题）' }}</p>
      <p v-if="card.summary && card.summary !== card.title" class="mt-1 line-clamp-3 text-xs text-gray-500">
        {{ card.summary }}
      </p>
      <p class="mt-1.5 text-[10px] text-gray-400">{{ formatTime(card.updatedAt) }}</p>
    </template>
  </BoardPanel>
</template>
