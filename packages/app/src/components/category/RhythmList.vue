<script setup lang="ts">
import { computed } from 'vue'

import type { RhythmCardSummaryView } from '@novai/core/services/types'
import Tooltip from '../ui/Tooltip.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 节奏分类面板（侧栏）：入口摘要 + 新建入口 + 最近节奏卡直达，与计划/伏笔分类
 * 同构。摘要口径：总卡数 + 偏差数（偏差是需要作者注意的信号）。
 */
const props = defineProps<{
  cards: RhythmCardSummaryView[]
  isLoading: boolean
  selectedCardId?: string | null
}>()

const emit = defineEmits<{
  openBoard: []
  refresh: []
  openCreate: []
  openCard: [id: string]
}>()

const deviatedCount = computed(() => props.cards.filter((card) => card.status === 'deviated').length)

/** 状态短标签（列表行尾） */
function statusLabel(status: RhythmCardSummaryView['status']): string {
  return status === 'planned' ? '规划' : status === 'written' ? '已写' : '偏差'
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">节奏</h2>
      <div class="flex items-center gap-1">
        <Tooltip text="刷新节奏卡" :delay="300" preferred-placement="bottom">
          <button
            class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isLoading"
            aria-label="刷新节奏卡"
            data-testid="rhythm-refresh-button"
            @click="emit('refresh')"
          >
            <AppIcon name="refresh-cw" :size="16" :class="['h-4 w-4', isLoading ? 'animate-spin' : '']" />
          </button>
        </Tooltip>
        <!-- 移动端关闭：由 CategoryPanel 注入，并排在标题行右端 -->
        <slot name="mobile-close" />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 入口摘要 -->
      <button
        class="mb-2 flex w-full flex-col gap-1 rounded-md bg-white/5 px-3 py-3 text-left transition-colors hover:bg-white/10"
        @click="emit('openBoard')"
      >
        <span class="text-sm text-gray-200">节奏账本</span>
        <span class="text-xs text-gray-500">
          {{ cards.length }} 张节奏卡<template v-if="deviatedCount > 0"> · 偏差 {{ deviatedCount }}</template>
        </span>
      </button>

      <!-- 新建节奏卡（摘要卡下方，与右侧详情互斥切换；草稿由 store 保留） -->
      <button
        class="mb-2 flex w-full items-center gap-1.5 rounded-md bg-white/5 px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-gray-200"
        aria-label="规划节奏卡"
        data-testid="rhythm-sidebar-create"
        @click="emit('openCreate')"
      >
        <AppIcon name="plus" :size="16" class="h-4 w-4 shrink-0" />
        规划节奏卡
      </button>

      <p v-if="isLoading && cards.length === 0" class="px-2 py-2 text-xs text-gray-600">正在读取节奏卡…</p>
      <p v-else-if="cards.length === 0" class="px-2 py-2 text-xs text-gray-600">
        还没有节奏卡。规划下一章的温度——冲突强度、情绪基调、章末钩子、爽点类型。
      </p>

      <!-- 最近更新（前 8 条，点击直达详情） -->
      <ul v-else class="space-y-0.5">
        <li v-for="card in cards.slice(0, 8)" :key="card.id">
          <button
            :class="[
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              selectedCardId === card.id
                ? 'bg-white/15 text-white'
                : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
            ]"
            @click="emit('openCard', card.id)"
          >
            <span class="flex-1 truncate">{{ card.name }}</span>
            <span
              :class="[
                'shrink-0 text-xs',
                card.status === 'deviated' ? 'text-red-400' : 'text-gray-600',
              ]"
            >{{ statusLabel(card.status) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
