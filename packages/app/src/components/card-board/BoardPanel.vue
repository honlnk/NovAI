<script setup lang="ts" generic="TCard extends { id: string }">
import { ref } from 'vue'

import { REPO_URL } from '../../constants/repo'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 看板主面板骨架（创作心智模块施工计划 §10.5，自计划模块上提泛化）：始终占据
 * 中间主内容区，白色体系。顶栏、骨架屏、悬浮错误横幅、空状态与拖拽机制通用；
 * 列集合（含筛选/分组口径）、卡片内容与顶栏扩展按钮由调用方注入。
 *
 * 拖拽（HTML5 DnD：卡片 → 列 / 卡片之间）与原地投放短路判定在骨架内完成，
 * moveCard 事件回传领域列 key（计划的状态 / 伏笔的分组列），由调用方解释。
 */
const props = defineProps<{
  /** 顶栏标题（如「创作计划板」「伏笔账本」） */
  title: string
  /** 卡片计数（全部列的合计，与展示口径无关） */
  totalCards: number
  /** 已经过领域筛选/分组的展示列（顺序即展示顺序） */
  columns: ReadonlyArray<{ key: string; label: string; cards: readonly TCard[] }>
  /** 骨架屏列数：与首载默认展示列一致（首载时还没有数据可跟随） */
  skeletonColumnCount: number
  /** 是否已有看板数据（null = 首载，骨架屏/居中重试的判定口径） */
  hasBoardData: boolean
  isLoading: boolean
  errorMessage: string
  selectedCardId: string | null
  /** 左侧分类侧栏是否展开（开关图标状态与其他页面一致） */
  isSidebarOpen: boolean
  /** 右侧内容面板是否可见（详情/新建均算展开） */
  isContentPanelOpen: boolean
  /** 空状态文案与新建按钮文案 */
  emptyText: string
  emptyCreateLabel: string
  /** data-testid 前缀（计划沿用 plan-*，伏笔 foreshadowing-*） */
  testidPrefix: string
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  /** 松手落定：id + 领域列 key + 目标位置前一卡片（列尾为 null） */
  moveCard: [id: string, columnKey: string, afterId: string | null]
  retryLoad: []
  toggleSidebar: []
  toggleMobileSidebar: []
  toggleContentPanel: []
}>()

/** 首载（还没有任何看板数据）才显示骨架屏；后台刷新一律保留旧看板 */
const isInitialLoading = () => props.isLoading && !props.hasBoardData

/* ---------- 拖拽（HTML5 DnD：卡片 → 列 / 卡片之间） ---------- */

const dragCardId = ref<string | null>(null)
const dropTarget = ref<{ columnKey: string; afterId: string | null } | null>(null)

function onCardDragStart(card: TCard, event: DragEvent) {
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

/** 卡片当前所在列；找不到返回 null（看板数据与拖拽瞬间不一致时按跨列移动处理） */
function findCardColumn(id: string): string | null {
  const source = props.columns.find(({ cards }) => cards.some((card) => card.id === id))
  return source ? source.key : null
}

/** 拖到某列的空白区：目标列为空或列尾。卡片已是该列列尾时属原地投放，不触发移动 */
function onColumnDrop(column: { key: string; cards: readonly TCard[] }) {
  const id = dragCardId.value
  if (!id) {
    return
  }
  const afterId = column.cards.length > 0 ? column.cards[column.cards.length - 1]?.id ?? null : null
  const currentIndex = findCardColumn(id) === column.key
    ? column.cards.findIndex((card) => card.id === id)
    : -1
  if (currentIndex !== -1 && currentIndex === column.cards.length - 1) {
    onCardDragEnd()
    return
  }
  emit('moveCard', id, column.key, afterId)
  onCardDragEnd()
}

/** 拖到某卡片上：插到该卡片之后。卡片已紧跟在该卡片之后时属原地投放，不触发移动 */
function onCardDrop(column: { key: string; cards: readonly TCard[] }, afterCard: TCard) {
  const id = dragCardId.value
  if (!id || id === afterCard.id) {
    onCardDragEnd()
    return
  }

  if (findCardColumn(id) === column.key) {
    const currentIndex = column.cards.findIndex((card) => card.id === id)
    if (currentIndex > 0 && column.cards[currentIndex - 1]?.id === afterCard.id) {
      onCardDragEnd()
      return
    }
  }

  emit('moveCard', id, column.key, afterCard.id)
  onCardDragEnd()
}
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-white text-gray-800">
    <!-- 顶栏：结构与其他分类中央头部一致（刷新在左侧标题行，新建在侧栏摘要卡下方） -->
    <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex items-center gap-2">
        <button
          aria-label="打开分类面板"
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:hidden"
          @click="emit('toggleMobileSidebar')"
        >
          <AppIcon name="menu" :size="20" class="h-5 w-5" />
        </button>
        <button
          :aria-label="isSidebarOpen ? '收起侧边栏' : '展开侧边栏'"
          class="hidden rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:block"
          @click="emit('toggleSidebar')"
        >
          <!-- 收起状态：显示汉堡菜单（暗示可以展开侧边栏） -->
          <AppIcon name="menu" :size="20" class="h-5 w-5" v-if="!isSidebarOpen" />
          <!-- 展开状态：显示侧边栏收起图标 -->
          <AppIcon name="chevrons-left" :size="20" class="h-5 w-5" v-else />
        </button>
        <h1 class="text-base font-semibold text-gray-800">{{ title }}</h1>
        <span class="shrink-0 text-xs text-gray-500">{{ totalCards }} 张卡片</span>

        <!-- 顶栏扩展位：领域筛选/切换按钮（如计划的已搁置筛选、伏笔的列模式） -->
        <slot name="header-extra" />
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
          <AppIcon name="chevron-right" :size="20" class="h-5 w-5 transition-transform duration-200" :class="isContentPanelOpen ? '' : 'rotate-180'" />
        </button>
      </div>
    </header>

    <!-- 错误横幅（后台刷新失败时旧看板仍在，可从这重试；首载失败走下方居中重试）。
         悬浮在看板上层，不占用文档流——错误的出现与消失不改变看板几何 -->
    <div
      v-if="errorMessage && hasBoardData"
      class="absolute inset-x-4 top-2 z-20 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 shadow-sm"
      role="alert"
    >
      <span>{{ errorMessage }}</span>
      <button
        class="shrink-0 rounded-md border border-red-200 px-2 py-0.5 font-medium text-red-600 transition-colors hover:bg-red-100"
        :data-testid="`${testidPrefix}-retry-banner-button`"
        @click="emit('retryLoad')"
      >
        重试
      </button>
    </div>

    <!-- 领域提示条（可选插槽，领域看板提供时才渲染；计划/伏笔不传则几何不变）：
         如节奏看板用它说明状态机与拖拽规则，避免「不能跨列拖拽」被误认为 bug -->
    <slot v-if="$slots['board-hint']" name="board-hint" />

    <!-- 首载骨架屏：默认列占位，读完后一次性换成真实看板 -->
    <div
      v-if="isInitialLoading()"
      class="flex flex-1 gap-3 overflow-x-auto p-4"
      aria-hidden="true"
      :data-testid="`${testidPrefix}-board-skeleton`"
    >
      <section
        v-for="n in skeletonColumnCount"
        :key="n"
        class="flex w-64 shrink-0 flex-col rounded-lg bg-gray-50"
      >
        <header class="flex items-center gap-2 px-3 py-2.5">
          <span class="h-3 w-12 animate-pulse rounded bg-gray-200" />
          <span class="h-3 w-5 animate-pulse rounded-full bg-gray-200" />
        </header>
        <div class="flex flex-1 flex-col gap-2 px-2 pb-2">
          <div
            v-for="n in 3"
            :key="n"
            class="h-20 animate-pulse rounded-md border border-gray-100 bg-white"
          />
        </div>
      </section>
    </div>
    <!-- 首载失败：没有可保留的旧看板，给重试入口 -->
    <div
      v-else-if="!hasBoardData && errorMessage"
      class="flex flex-1 flex-col items-center justify-center gap-3"
    >
      <p class="text-sm text-gray-500">{{ errorMessage }}</p>
      <button
        class="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
        :data-testid="`${testidPrefix}-retry-button`"
        @click="emit('retryLoad')"
      >
        重试
      </button>
    </div>
    <div
      v-else-if="totalCards === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3"
    >
      <p class="text-sm text-gray-500">{{ emptyText }}</p>
      <button
        class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        :data-testid="`${testidPrefix}-empty-create`"
        @click="emit('openCreate')"
      >
        {{ emptyCreateLabel }}
      </button>
    </div>
    <div v-else class="flex flex-1 gap-3 overflow-x-auto p-4">
      <section
        v-for="column in columns"
        :key="column.key"
        class="flex w-64 shrink-0 flex-col rounded-lg bg-gray-50"
        @dragover.prevent
        @drop.prevent="onColumnDrop(column)"
      >
        <header class="flex items-center gap-2 px-3 py-2.5">
          <h2 class="text-xs font-semibold text-gray-600">{{ column.label }}</h2>
          <span class="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-500">{{ column.cards.length }}</span>
        </header>

        <div class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          <p v-if="column.cards.length === 0" class="px-1 py-4 text-center text-xs text-gray-400">
            拖卡片到这里
          </p>

          <article
            v-for="card in column.cards"
            :key="card.id"
            :class="[
              'group relative cursor-pointer rounded-md border bg-white p-2.5 transition-colors hover:border-gray-300 focus-visible:outline-2 focus-visible:outline-gray-900',
              dragCardId === card.id ? 'opacity-40' : '',
              selectedCardId === card.id ? 'border-gray-900' : 'border-gray-200',
            ]"
            draggable="true"
            tabindex="0"
            :data-testid="`${testidPrefix}-card`"
            @click="emit('openCard', card.id)"
            @keydown.enter.prevent="emit('openCard', card.id)"
            @keydown.space.prevent="emit('openCard', card.id)"
            @dragstart="onCardDragStart(card, $event)"
            @dragend="onCardDragEnd"
            @dragover.prevent="dropTarget = { columnKey: column.key, afterId: card.id }"
            @dragleave="dropTarget = null"
            @drop.prevent.stop="onCardDrop(column, card)"
          >
            <!-- 插入指示：悬浮在卡片上边缘的等占地横条，不改变边框厚度与卡片位置 -->
            <span
              v-if="dropTarget?.columnKey === column.key && dropTarget.afterId === card.id"
              class="absolute inset-x-1 -top-1 z-10 h-0.5 rounded-full bg-gray-900"
              aria-hidden="true"
              :data-testid="`${testidPrefix}-drop-indicator`"
            />
            <!-- 卡片内容：领域注入（标题/摘要/时间或伏笔的埋设章节与回收窗口） -->
            <slot name="card-content" :card="card" />
          </article>
        </div>
      </section>
    </div>
  </div>
</template>
