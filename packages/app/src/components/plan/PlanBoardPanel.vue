<script setup lang="ts">
import { computed, ref } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'

/**
 * 计划看板主面板（布局统一计划 D1/D6/D8/D9）：始终占据中间主内容区，白色体系。
 *
 * 与旧版的差别（§3/§四 替代表）：
 * - 详情与新建迁入工作区右侧内容面板，看板内不再保留任何内嵌抽屉；
 * - 刷新移到左侧计划标题行，看板右上只保留「新建计划」（统一中性色主按钮）；
 * - 顶栏保留标题、卡片总数与已搁置筛选（内容筛选，不随入口迁移）；
 * - 宽度不足时仅看板列区域横向滚动，顶栏不被逐字挤压。
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
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  moveCard: [id: string, status: PlanStatusView, afterId: string | null]
  toggleOnHold: []
}>()

const columns = computed(() => {
  if (!props.board) {
    return []
  }

  const entries = Object.entries(props.board.columns) as [PlanStatusView, PlanCardSummaryView[]][]
  return props.showOnHold
    ? entries.filter(([status]) => status === 'on-hold')
    : entries.filter(([status]) => status !== 'on-hold')
})

const totalCards = computed(() => {
  if (!props.board) {
    return 0
  }
  return (Object.values(props.board.columns) as PlanCardSummaryView[][])
    .reduce((total, cards) => total + cards.length, 0)
})

/* ---------- 拖拽（HTML5 DnD：卡片 → 列 / 卡片之间） ---------- */

const dragCardId = ref<string | null>(null)
const dropTarget = ref<{ status: PlanStatusView; afterId: string | null } | null>(null)

function onCardDragStart(card: PlanCardSummaryView, event: DragEvent) {
  dragCardId.value = card.id
  event.dataTransfer?.setData('text/plain', card.id)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onCardDragEnd() {
  dragCardId.value = null
  dropTarget.value = null
}

/** 拖到某列的空白区：目标列为空或列尾 */
function onColumnDrop(status: PlanStatusView) {
  const id = dragCardId.value
  if (!id) {
    return
  }
  const column = props.board?.columns[status] ?? []
  const afterId = column.length > 0 ? column[column.length - 1]?.id ?? null : null
  emit('moveCard', id, status, afterId)
  onCardDragEnd()
}

/** 拖到某卡片上：插到该卡片之后 */
function onCardDrop(status: PlanStatusView, afterCard: PlanCardSummaryView) {
  const id = dragCardId.value
  if (!id || id === afterCard.id) {
    onCardDragEnd()
    return
  }
  emit('moveCard', id, status, afterCard.id)
  onCardDragEnd()
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
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-white text-gray-800">
    <!-- 顶栏：标题 + 计数 + 搁置筛选 + 新建（刷新在左侧计划标题行） -->
    <header class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3">
      <h1 class="text-base font-semibold text-gray-800">创作计划板</h1>
      <span class="shrink-0 text-xs text-gray-500">{{ totalCards }} 张卡片</span>

      <button
        :class="[
          'shrink-0 rounded-md border px-2 py-1 text-xs transition-colors',
          showOnHold
            ? 'border-gray-900 bg-gray-900 text-white'
            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100',
        ]"
        aria-label="查看已搁置的卡片"
        @click="emit('toggleOnHold')"
      >
        已搁置
      </button>

      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800"
          aria-label="新建计划"
          data-testid="plan-new-card-button"
          @click="emit('openCreate')"
        >
          + 新建计划
        </button>
      </div>
    </header>

    <!-- 错误横幅（看板级错误） -->
    <p v-if="errorMessage" class="shrink-0 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
      {{ errorMessage }}
    </p>

    <!-- 主体：看板列区（宽度不足时仅列区横向滚动，顶栏不受挤压） -->
    <div
      v-if="isLoading"
      class="flex flex-1 items-center justify-center text-sm text-gray-400"
    >
      正在读取计划…
    </div>
    <div
      v-else-if="totalCards === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3"
    >
      <p class="text-sm text-gray-500">还没有计划。把准备安排的剧情、伏笔、灵感或待补设定记下来。</p>
      <button
        class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        data-testid="plan-empty-create"
        @click="emit('openCreate')"
      >
        新建一条计划
      </button>
    </div>
    <div v-else class="flex flex-1 gap-3 overflow-x-auto p-4">
      <section
        v-for="[status, cards] in columns"
        :key="status"
        class="flex w-64 shrink-0 flex-col rounded-lg bg-gray-50"
        @dragover.prevent
        @drop.prevent="onColumnDrop(status)"
      >
        <header class="flex items-center gap-2 px-3 py-2.5">
          <h2 class="text-xs font-semibold text-gray-600">{{ PLAN_COLUMN_LABELS[status] }}</h2>
          <span class="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-500">{{ cards.length }}</span>
        </header>

        <div class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          <p v-if="cards.length === 0" class="px-1 py-4 text-center text-xs text-gray-400">
            拖卡片到这里
          </p>

          <article
            v-for="card in cards"
            :key="card.id"
            :class="[
              'group cursor-pointer rounded-md border bg-white p-2.5 transition-colors hover:border-gray-300',
              dragCardId === card.id ? 'opacity-40' : '',
              selectedCardId === card.id ? 'border-gray-900' : 'border-gray-200',
              dropTarget?.status === status && dropTarget.afterId === card.id ? 'border-t-2 border-t-gray-900' : '',
            ]"
            draggable="true"
            data-testid="plan-card"
            @click="emit('openCard', card.id)"
            @dragstart="onCardDragStart(card, $event)"
            @dragend="onCardDragEnd"
            @dragover.prevent="dropTarget = { status, afterId: card.id }"
            @dragleave="dropTarget = null"
            @drop.prevent.stop="onCardDrop(status, card)"
          >
            <p class="text-sm font-medium text-gray-800">{{ card.title || '（无标题）' }}</p>
            <p v-if="card.summary && card.summary !== card.title" class="mt-1 line-clamp-3 text-xs text-gray-500">
              {{ card.summary }}
            </p>
            <p class="mt-1.5 text-[10px] text-gray-400">{{ formatTime(card.updatedAt) }}</p>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>
