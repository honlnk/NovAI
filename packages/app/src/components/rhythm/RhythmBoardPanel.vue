<script setup lang="ts">
import { computed } from 'vue'

import type { RhythmCardSummaryView, RhythmStatusView } from '@novai/core/services/types'
import BoardPanel from '../card-board/BoardPanel.vue'
import {
  conflictIntensityClass,
  isRhythmReorderOnly,
  rhythmDisplayColumns,
} from '../../constants/rhythm'

/**
 * 节奏看板主面板：通用看板骨架的节奏领域装配（§七）。固定三列（规划中/已写/
 * 偏差）；状态不由 UI 手改——拖拽只放行同列重排（偏差列不可拖出，规划中/已写
 * 之间也不可互拖），跨列流转全由 actual_* 回写的偏差判定驱动。
 *
 * 卡片展示：章节名 + 计划冲突强度（1~3 绿/4~6 黄/7~10 红）+ 情绪/钩子标签；
 * 已回写时给计划↔实际对比（一致绿勾、偏差红警）。
 */
const props = defineProps<{
  board: {
    columns: Readonly<Record<RhythmStatusView, readonly RhythmCardSummaryView[]>>
    issues: readonly unknown[]
  } | null
  isLoading: boolean
  errorMessage: string
  selectedCardId: string | null
  isSidebarOpen: boolean
  isContentPanelOpen: boolean
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  moveCard: [id: string, status: RhythmStatusView, afterId: string | null, beforeId?: string | null]
  retryLoad: []
  toggleSidebar: []
  toggleMobileSidebar: []
  toggleContentPanel: []
}>()

/** 全部卡（计数的输入） */
const allCards = computed(() => {
  if (!props.board) {
    return []
  }
  return (Object.values(props.board.columns) as RhythmCardSummaryView[][]).flat()
})

const totalCards = computed(() => allCards.value.length)

const columns = computed(() => rhythmDisplayColumns(props.board))

/** 落点放行：同列重排才显示占位并上抛（跨列拖拽静默忽略——状态只由回写驱动） */
function isRhythmDropAllowed(id: string, columnKey: string) {
  return isRhythmReorderOnly(props.board, id, columnKey)
}

function onBoardMoveCard(id: string, columnKey: string, afterId: string | null, beforeId?: string | null) {
  if (isRhythmReorderOnly(props.board, id, columnKey)) {
    emit('moveCard', id, columnKey as RhythmStatusView, afterId, beforeId)
  }
}

/** 计划↔实际对比：已回写时给一致/偏差结论（卡片右下角绿勾或红警） */
function compareSummary(card: RhythmCardSummaryView): { ok: boolean; text: string } | null {
  if (card.actualConflict === null) {
    return null
  }
  const ok = !card.deviationFlag
  const parts = [`实际 ${card.actualConflict} · ${card.actualMood ?? '—'} · ${card.actualHook ?? '—'} · ${card.actualPayoff ?? '—'}`]
  return { ok, text: ok ? `${parts[0]} ✓` : `${parts[0]} ⚠` }
}
</script>

<template>
  <BoardPanel
    title="节奏账本"
    :total-cards="totalCards"
    :columns="columns"
    :skeleton-column-count="3"
    :has-board-data="board !== null"
    :is-loading="isLoading"
    :error-message="errorMessage"
    :selected-card-id="selectedCardId"
    :is-sidebar-open="isSidebarOpen"
    :is-content-panel-open="isContentPanelOpen"
    empty-text="还没有节奏卡。规划下一章要什么温度——冲突强度、情绪基调、章末钩子、爽点类型。"
    empty-create-label="规划一张节奏卡"
    testid-prefix="rhythm"
    empty-column-text="暂无节奏卡"
    :can-drop-card="isRhythmDropAllowed"
    @open-create="emit('openCreate')"
    @open-card="emit('openCard', $event)"
    @move-card="onBoardMoveCard"
    @retry-load="emit('retryLoad')"
    @toggle-sidebar="emit('toggleSidebar')"
    @toggle-mobile-sidebar="emit('toggleMobileSidebar')"
    @toggle-content-panel="emit('toggleContentPanel')"
  >
    <template #board-hint>
      <div
        class="flex shrink-0 items-center gap-1.5 border-b border-gray-100 bg-gray-50/60 px-4 py-1.5 text-[11px] leading-relaxed text-gray-500"
        data-testid="rhythm-board-hint"
      >
        三列状态不是手动归档：写完章节后回写实际值，系统自动判定（与计划一致 → 已写，走样 → 偏差）。跨列拖拽不可用，拖动仅调整列内顺序。
      </div>
    </template>

    <template #card-content="{ card }">
      <div class="flex items-start justify-between gap-1.5">
        <p class="min-w-0 flex-1 truncate text-sm font-medium text-gray-800" :title="card.name">{{ card.name }}</p>
        <!-- 计划冲突强度：1~3 绿 / 4~6 黄 / 7~10 红 -->
        <span
          :class="['shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', conflictIntensityClass(card.plannedConflict)]"
          title="计划冲突强度"
        >{{ card.plannedConflict }}</span>
      </div>
      <p class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
        <span class="truncate">{{ card.chapterRef }}</span>
        <span class="rounded bg-gray-100 px-1 py-px">{{ card.plannedMood }}</span>
        <span v-if="card.plannedHook !== '无'" class="rounded bg-gray-100 px-1 py-px">钩子·{{ card.plannedHook }}</span>
        <span v-if="card.plannedPayoff !== '无'" class="rounded bg-gray-100 px-1 py-px">{{ card.plannedPayoff }}</span>
      </p>
      <p v-if="card.summary" class="mt-1 line-clamp-2 text-xs text-gray-400">{{ card.summary }}</p>
      <!-- 已回写：计划↔实际对比（一致绿勾 / 偏差红警） -->
      <p
        v-if="compareSummary(card)"
        :class="[
          'mt-1.5 rounded px-1.5 py-0.5 text-[10px]',
          compareSummary(card)!.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600',
        ]"
        :title="card.deviationFlag ? '实际值与计划的偏差说明见详情' : '实际值与计划一致'"
      >
        {{ compareSummary(card)!.text }}
      </p>
    </template>
  </BoardPanel>
</template>
