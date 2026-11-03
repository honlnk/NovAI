<script setup lang="ts">
import { computed } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'

/**
 * 计划分类面板（侧栏）：只显示入口摘要与新建按钮——完整四列看板在主内容区
 * （PlanBoardPanel 替换对话面板），侧栏不重复塞一块小看板。
 */

const props = defineProps<{
  cards: PlanCardSummaryView[]
  isLoading: boolean
}>()

const emit = defineEmits<{
  /** 打开主内容区看板（点入口或卡片时） */
  openBoard: []
  create: []
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
      <button
        class="rounded-md bg-white/10 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-white/20"
        aria-label="新建计划"
        @click="emit('create')"
      >
        + 新建
      </button>
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

      <!-- 最近更新（前 8 张，点击直达详情） -->
      <ul v-else class="space-y-0.5">
        <li v-for="card in cards.slice(0, 8)" :key="card.id">
          <button
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
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
