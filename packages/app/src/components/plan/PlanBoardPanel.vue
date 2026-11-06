<script setup lang="ts">
import { computed, ref } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import { REPO_URL } from '../../constants/repo'

/**
 * 计划看板主面板（布局统一计划 D1/D6/D9）：始终占据中间主内容区，白色体系。
 *
 * 与旧版的差别（§3/§四 替代表）：
 * - 详情与新建迁入工作区右侧内容面板，看板内不再保留任何内嵌抽屉；
 * - 刷新在左侧计划标题行，新建在侧栏摘要卡下方（2026-11-06 用户决策推翻 D8 的
 *   「看板右上保留新建」：顶栏右端与其他页面统一为 GitHub + 内容面板开关）；
 * - 顶栏结构与其他分类中央头部一致：左侧侧栏开关 + 标题 + 计数 + 已搁置筛选，
 *   右侧 GitHub 仓库 + 内容面板收起/展开；
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
  /** 左侧分类侧栏是否展开（开关图标状态与其他页面一致） */
  isSidebarOpen: boolean
  /** 右侧内容面板是否可见（计划详情/新建均算展开） */
  isContentPanelOpen: boolean
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  moveCard: [id: string, status: PlanStatusView, afterId: string | null]
  toggleOnHold: []
  toggleSidebar: []
  toggleMobileSidebar: []
  toggleContentPanel: []
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
    <!-- 顶栏：结构与其他分类中央头部一致（刷新在左侧计划标题行，新建在侧栏摘要卡下方） -->
    <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex items-center gap-2">
        <button
          aria-label="打开分类面板"
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:hidden"
          @click="emit('toggleMobileSidebar')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          :aria-label="isSidebarOpen ? '收起侧边栏' : '展开侧边栏'"
          class="hidden rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:block"
          @click="emit('toggleSidebar')"
        >
          <!-- 收起状态：显示汉堡菜单（暗示可以展开侧边栏） -->
          <svg v-if="!isSidebarOpen" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <!-- 展开状态：显示侧边栏收起图标 -->
          <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
        <h1 class="text-base font-semibold text-gray-800">创作计划板</h1>
        <span class="shrink-0 text-xs text-gray-500">{{ totalCards }} 张卡片</span>

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
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <a
          :href="REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub 仓库"
          title="GitHub 仓库"
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
        >
          <svg class="h-5 w-5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </a>
        <button
          :aria-label="isContentPanelOpen ? '收起内容面板' : '展开内容面板'"
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
          @click="emit('toggleContentPanel')"
        >
          <svg
            class="h-5 w-5 transition-transform duration-200"
            :class="isContentPanelOpen ? '' : 'rotate-180'"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
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
              'group cursor-pointer rounded-md border bg-white p-2.5 transition-colors hover:border-gray-300 focus-visible:outline-2 focus-visible:outline-gray-900',
              dragCardId === card.id ? 'opacity-40' : '',
              selectedCardId === card.id ? 'border-gray-900' : 'border-gray-200',
              dropTarget?.status === status && dropTarget.afterId === card.id ? 'border-t-2 border-t-gray-900' : '',
            ]"
            draggable="true"
            tabindex="0"
            data-testid="plan-card"
            @click="emit('openCard', card.id)"
            @keydown.enter.prevent="emit('openCard', card.id)"
            @keydown.space.prevent="emit('openCard', card.id)"
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
