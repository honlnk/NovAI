<script setup lang="ts">
import { computed } from 'vue'

import type { ForeshadowingCardSummaryView } from '@novai/core/services/types'
import { FORESHADOWING_STATUS_SHORT_LABELS } from '../../constants/foreshadowing'
import Tooltip from '../ui/Tooltip.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 伏笔分类面板（侧栏）：入口摘要 + 新建入口 + 最近伏笔直达，与计划分类同构
 * （布局统一计划 D7/D8 的模式）。摘要口径：总条数 + 未收（已埋/推进中）数量。
 */
const props = defineProps<{
  cards: ForeshadowingCardSummaryView[]
  isLoading: boolean
  /** 当前打开详情的伏笔 id（列表选中态与详情一致） */
  selectedCardId?: string | null
}>()

const emit = defineEmits<{
  openBoard: []
  refresh: []
  openCreate: []
  openCard: [id: string]
}>()

/** 未收口径：已埋 + 暗示 + 发展（还没揭晓/解决/放弃） */
const openCount = computed(() =>
  props.cards.filter((card) => card.status === 'planted' || card.status === 'hinted' || card.status === 'developed').length,
)
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">伏笔</h2>
      <div class="flex items-center gap-1">
        <Tooltip
          text="刷新伏笔"
          :delay="300"
          preferred-placement="bottom"
        >
          <button
            class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isLoading"
            aria-label="刷新伏笔"
            data-testid="foreshadowing-refresh-button"
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
        <span class="text-sm text-gray-200">伏笔账本</span>
        <span class="text-xs text-gray-500">
          {{ cards.length }} 条伏笔 · 未收 {{ openCount }}
        </span>
      </button>

      <!-- 新建伏笔（摘要卡下方，与右侧详情互斥切换；草稿由 store 保留） -->
      <button
        class="mb-2 flex w-full items-center gap-1.5 rounded-md bg-white/5 px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-gray-200"
        aria-label="登记伏笔"
        data-testid="foreshadowing-sidebar-create"
        @click="emit('openCreate')"
      >
        <AppIcon name="plus" :size="16" class="h-4 w-4 shrink-0" />
        登记伏笔
      </button>

      <p v-if="isLoading && cards.length === 0" class="px-2 py-2 text-xs text-gray-600">正在读取伏笔…</p>
      <p v-else-if="cards.length === 0" class="px-2 py-2 text-xs text-gray-600">
        还没有伏笔。正文里埋下线索后，在这里登记——欠了读者什么、什么时候还。
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
            <span class="shrink-0 text-xs text-gray-600">{{ FORESHADOWING_STATUS_SHORT_LABELS[card.status] }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
