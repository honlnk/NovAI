<script setup lang="ts">
import { computed } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import Tooltip from '../ui/Tooltip.vue'

/**
 * 计划分类面板（侧栏）：入口摘要 + 最近计划直达。布局统一计划 D7/D8：
 * 原左侧「新建」按钮替换为刷新图标按钮（看板右上保留唯一新建入口）；
 * 当前打开的计划与看板/右侧详情的选中态一致。
 */

const props = defineProps<{
  cards: PlanCardSummaryView[]
  isLoading: boolean
  /** 当前打开详情的卡片 id（列表选中态与详情一致） */
  selectedCardId?: string | null
}>()

const emit = defineEmits<{
  /** 打开主内容区看板（点入口或卡片时） */
  openBoard: []
  /** 刷新计划（原左侧新建位置，刷新期间禁用防重复触发） */
  refresh: []
  /** 点击某张卡片：打开看板并选中该卡详情 */
  openCard: [id: string]
}>()

const inboxCount = computed(() => props.cards.filter((card) => card.status === 'inbox').length)
const activeCount = computed(() => props.cards.filter((card) => card.status === 'in-progress').length)

function statusShortLabel(status: PlanStatusView): string {
  switch (status) {
    case 'inbox': return '收集'
    case 'planned': return '计划'
    case 'in-progress': return '进行'
    case 'done': return '完成'
    case 'on-hold': return '搁置'
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">计划</h2>
      <Tooltip
        text="刷新计划"
        :delay="300"
        preferred-placement="bottom"
      >
        <button
          class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="isLoading"
          aria-label="刷新计划"
          data-testid="plan-refresh-button"
          @click="emit('refresh')"
        >
          <svg
            :class="['h-4 w-4', isLoading ? 'animate-spin' : '']"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </Tooltip>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 入口摘要 -->
      <button
        class="mb-2 flex w-full flex-col gap-1 rounded-md bg-white/5 px-3 py-3 text-left transition-colors hover:bg-white/10"
        @click="emit('openBoard')"
      >
        <span class="text-sm text-gray-200">创作计划板</span>
        <span class="text-xs text-gray-500">
          {{ cards.length }} 张卡片 · 收集箱 {{ inboxCount }} · 进行中 {{ activeCount }}
        </span>
      </button>

      <p v-if="isLoading" class="px-2 py-2 text-xs text-gray-600">正在读取计划…</p>
      <p v-else-if="cards.length === 0" class="px-2 py-2 text-xs text-gray-600">
        还没有计划。新建一条，或在看板里随时记录灵感与伏笔。
      </p>

      <!-- 最近更新（前 8 张，点击直达详情；选中态与当前打开的详情一致） -->
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
            <span class="flex-1 truncate">{{ card.title || '（无标题）' }}</span>
            <span class="shrink-0 text-xs text-gray-600">{{ statusShortLabel(card.status) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
