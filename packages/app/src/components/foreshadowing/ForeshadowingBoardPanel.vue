<script setup lang="ts">
import { computed } from 'vue'

import type { ForeshadowingCardSummaryView, ForeshadowingStatusView } from '@novai/core/services/types'
import { FORESHADOWING_STATUS_LABELS, type ForeshadowingStatus } from '@novai/core/types/foreshadowing'
import {
  foreshadowingDisplayColumns,
  isForeshadowingDue,
  resolveForeshadowingMoveStatus,
  type ForeshadowingColumnMode,
} from '../../constants/foreshadowing'
import BoardPanel from '../card-board/BoardPanel.vue'

/**
 * 伏笔看板主面板：通用看板骨架（components/card-board/BoardPanel.vue）的伏笔领域
 * 装配。列口径由项目设置驱动——默认 4 列（frontmatter 6 状态按展示口径分组），
 * 完整模式 6 列；「该收了」高亮：最新章号进入回收窗口起点且尚未揭晓/解决的伏笔
 * （创作心智模块施工计划 §七）。拖拽落点先解析回目标状态再交 store（默认模式
 * 同列重排保持原状态，跨列取入口状态）。
 */
const props = defineProps<{
  board: {
    columns: Readonly<Record<ForeshadowingStatusView, readonly ForeshadowingCardSummaryView[]>>
    issues: readonly unknown[]
  } | null
  isLoading: boolean
  errorMessage: string
  selectedCardId: string | null
  /** 列模式（项目设置 foreshadowingStatusMode：default 4 列 / full 6 列） */
  columnMode: ForeshadowingColumnMode
  /** 当前最新章号（该收了高亮的判定基准）；无章节时为 null */
  latestChapterNumber: number | null
  isSidebarOpen: boolean
  isContentPanelOpen: boolean
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  moveCard: [id: string, status: ForeshadowingStatusView, afterId: string | null]
  retryLoad: []
  toggleColumnMode: []
  toggleSidebar: []
  toggleMobileSidebar: []
  toggleContentPanel: []
}>()

const columns = computed(() => foreshadowingDisplayColumns(props.board, props.columnMode))

const totalCards = computed(() => {
  if (!props.board) {
    return 0
  }
  return (Object.values(props.board.columns) as ForeshadowingCardSummaryView[][])
    .reduce((total, cards) => total + cards.length, 0)
})

/** 骨架屏列数：与两种模式的展示列数一致 */
const skeletonColumnCount = computed(() => (props.columnMode === 'full' ? 6 : 4))

function isDue(card: ForeshadowingCardSummaryView): boolean {
  return isForeshadowingDue(card, props.latestChapterNumber)
}

/** 看板落点 → 目标状态：默认模式同列重排保持原状态（hinted/developed 不互改） */
function onBoardMoveCard(id: string, columnKey: string, afterId: string | null) {
  const status = resolveForeshadowingMoveStatus(props.board, id, columnKey, props.columnMode)
  if (status) {
    emit('moveCard', id, status, afterId)
  }
}

function statusLabel(status: ForeshadowingStatus): string {
  return FORESHADOWING_STATUS_LABELS[status]
}
</script>

<template>
  <BoardPanel
    title="伏笔账本"
    :total-cards="totalCards"
    :columns="columns"
    :skeleton-column-count="skeletonColumnCount"
    :has-board-data="board !== null"
    :is-loading="isLoading"
    :error-message="errorMessage"
    :selected-card-id="selectedCardId"
    :is-sidebar-open="isSidebarOpen"
    :is-content-panel-open="isContentPanelOpen"
    empty-text="还没有伏笔。把埋进正文的线索登记下来——欠了读者什么、打算什么时候还。"
    empty-create-label="登记一条伏笔"
    testid-prefix="foreshadowing"
    @open-create="emit('openCreate')"
    @open-card="emit('openCard', $event)"
    @move-card="onBoardMoveCard"
    @retry-load="emit('retryLoad')"
    @toggle-sidebar="emit('toggleSidebar')"
    @toggle-mobile-sidebar="emit('toggleMobileSidebar')"
    @toggle-content-panel="emit('toggleContentPanel')"
  >
    <template #header-extra>
      <button
        :class="[
          'ml-1 shrink-0 rounded-md border px-2 py-1 text-xs transition-colors',
          columnMode === 'full'
            ? 'border-gray-900 bg-gray-900 text-white'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100',
        ]"
        :aria-label="columnMode === 'full' ? '切回默认四列' : '查看完整六状态'"
        data-testid="foreshadowing-column-mode"
        @click="emit('toggleColumnMode')"
      >
        {{ columnMode === 'full' ? '完整 6 列' : '默认 4 列' }}
      </button>
    </template>

    <template #card-content="{ card }">
      <div class="flex items-start justify-between gap-1.5">
        <p class="text-sm font-medium text-gray-800">{{ card.name }}</p>
        <!-- 该收了：最新章号已进入回收窗口（§七高亮规则） -->
        <span
          v-if="isDue(card)"
          class="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
          title="最新章节已进入该伏笔的回收窗口"
        >
          该收了
        </span>
      </div>
      <p class="mt-1 text-[11px] text-gray-500">
        埋于 {{ card.plantedAt || '未填章节' }}
        <template v-if="card.payoffWindow">
          · 回收 {{ card.payoffWindow[0] }} ~ {{ card.payoffWindow[1] }}
        </template>
        <template v-else>
          · 未设回收窗口
        </template>
      </p>
      <p v-if="card.summary" class="mt-1 line-clamp-2 text-xs text-gray-400">{{ card.summary }}</p>
      <p class="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-400">
        <span
          v-if="card.isRedHerring"
          class="rounded bg-gray-100 px-1 py-px text-gray-500"
          title="故意误导读者的红鲱鱼"
        >红鲱鱼</span>
        <span v-if="columnMode === 'default' && (card.status === 'hinted' || card.status === 'developed' || card.status === 'revealed' || card.status === 'resolved')">
          {{ statusLabel(card.status) }}
        </span>
      </p>
    </template>
  </BoardPanel>
</template>
