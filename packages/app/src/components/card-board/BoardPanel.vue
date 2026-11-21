<script setup lang="ts" generic="TCard extends { id: string }">
import { onBeforeUnmount, ref } from 'vue'

import { REPO_URL } from '../../constants/repo'
import AppIcon from '../ui/AppIcon.vue'
import {
  boardDropInsertionIndex,
  boardMovePositionForInsertion,
} from './board-reorder'
import {
  animateDragSlot,
  type DragAnimationClock,
  type DragSlotFrame,
} from './drag-slot-animation'

/**
 * 看板主面板骨架（创作心智模块施工计划 §10.5，自计划模块上提泛化）：始终占据
 * 中间主内容区，白色体系。顶栏、骨架屏、悬浮错误横幅、空状态与拖拽机制通用；
 * 列集合（含筛选/分组口径）、卡片内容与顶栏扩展按钮由调用方注入。
 *
 * 拖拽（HTML5 DnD）反馈为「原位塌陷 + 落点占位」：拖起后原卡片变透明并线性
 * 收缩到 0（下方卡片补位）；按卡片垂直中心线判定插入位置，目标位置以一张
 * 等高占位卡线性展开指示，松手瞬间由真实卡片接管。原生拖影保留，落点判定、
 * 原地投放短路与 moveCard 事件在骨架内完成，由调用方解释领域列 key。
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
  /** 空列常驻文案；默认「拖卡片到这里」，不支持跨列拖入的看板换成中性说明 */
  emptyColumnText?: string
  /** 落点放行（默认全部允许）：如节奏看板只放行同列重排，跨列不显示占位也不可放 */
  canDropCard?: (id: string, columnKey: string) => boolean
  /** 测试用同一虚拟时钟驱动定时器与动画进度；生产环境不传 */
  animationClock?: DragAnimationClock
}>()

const emit = defineEmits<{
  openCreate: []
  openCard: [id: string]
  /**
   * 松手落定：id + 领域列 key + 目标位置前一卡片（列尾为 null）；插到列首时
   * afterId 为 null 且给 beforeId（目标列首卡；空列无首卡时 beforeId=null）。
   */
  moveCard: [id: string, columnKey: string, afterId: string | null, beforeId?: string | null]
  retryLoad: []
  toggleSidebar: []
  toggleContentPanel: []
}>()

/** 首载（还没有任何看板数据）才显示骨架屏；后台刷新一律保留旧看板 */
const isInitialLoading = () => props.isLoading && !props.hasBoardData

/* ---------- 拖拽（原位塌陷 + 中心线落点 + 占位卡展开） ---------- */

/** 卡片之间的垂直间距（px）：由卡片槽自带，塌陷时随高度一起收回 */
const CARD_SLOT_GAP_PX = 8
const PLACEHOLDER_COLLAPSE_MS = 180

type DropSlot = { columnKey: string; insertionIndex: number }
type DropPlaceholder = DropSlot & { key: number; frame: DragSlotFrame }
type BoardRenderItem =
  | { kind: 'card'; card: TCard; isDragSource: boolean }
  | { kind: 'placeholder'; placeholder: DropPlaceholder }

const boardRoot = ref<HTMLElement | null>(null)
const dragCardId = ref<string | null>(null)
/** 被拖卡片视觉高度（px）：原位塌陷与占位卡展开共用，保证占位与真实卡等高 */
const dragCardHeight = ref(0)
const dragSourceFrame = ref<DragSlotFrame>({ height: 0, paddingBottom: CARD_SLOT_GAP_PX, opacity: 1 })
const dropSlot = ref<DropSlot | null>(null)
/** 活跃落点与正在退场的旧落点分开保留：移动时旧卡收缩、新卡从 0 展开 */
const dropPlaceholders = ref<DropPlaceholder[]>([])
const activeDropPlaceholderKey = ref<number | null>(null)
let nextDropPlaceholderKey = 0

const animationTimers = new Set<number>()
let cancelSourceAnimation: (() => void) | null = null
const cancelPlaceholderAnimations = new Map<number, () => void>()
const cancelPlaceholderFades = new Map<number, () => void>()
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

const zeroFrame = (): DragSlotFrame => ({ height: 0, paddingBottom: 0, opacity: 0 })
const fullFrame = (): DragSlotFrame => ({
  height: dragCardHeight.value,
  paddingBottom: CARD_SLOT_GAP_PX,
  opacity: 1,
})

function clearSourceAnimation() {
  cancelSourceAnimation?.()
  cancelSourceAnimation = null
}

function clearPlaceholderAnimation(key: number) {
  cancelPlaceholderAnimations.get(key)?.()
  cancelPlaceholderAnimations.delete(key)
  cancelPlaceholderFades.get(key)?.()
  cancelPlaceholderFades.delete(key)
}

function writePlaceholderFrame(key: number, frame: DragSlotFrame) {
  // 数组 push 后模板读取的是响应式代理；必须写回同一个代理，不能只改原始对象
  const current = dropPlaceholders.value.find((item) => item.key === key)
  if (current) {
    current.frame = frame
  }
}

function removeDropPlaceholder(key: number) {
  clearPlaceholderAnimation(key)
  dropPlaceholders.value = dropPlaceholders.value.filter((placeholder) => placeholder.key !== key)
}

function cancelAnimationTimers() {
  for (const id of animationTimers) {
    window.clearTimeout(id)
  }
  animationTimers.clear()
}

function cancelDragAnimations() {
  cancelAnimationTimers()
  clearSourceAnimation()
  for (const key of cancelPlaceholderAnimations.keys()) {
    clearPlaceholderAnimation(key)
  }
}

onBeforeUnmount(cancelDragAnimations)

/** 显式锁定拖影：后续源卡透明/塌陷不得影响浏览器已经抓取的卡片快照 */
function setCardDragImage(card: HTMLElement, dataTransfer: DataTransfer, pointer: { x: number; y: number }) {
  if (typeof dataTransfer.setDragImage !== 'function') {
    return
  }
  const rect = card.getBoundingClientRect()
  // 克隆一份未带 opacity-0 的卡片放在视口外，固定快照尺寸，避免受源卡布局变化影响
  const image = card.cloneNode(true) as HTMLElement
  image.classList.remove('opacity-0')
  image.style.position = 'fixed'
  image.style.left = '-10000px'
  image.style.top = '0px'
  image.style.width = `${rect.width}px`
  image.style.height = `${rect.height}px`
  image.style.margin = '0'
  image.style.opacity = '1'
  image.style.pointerEvents = 'none'
  image.setAttribute('aria-hidden', 'true')
  document.body.append(image)
  try {
    dataTransfer.setDragImage(image, pointer.x - rect.left, pointer.y - rect.top)
    // 不在 dragstart 同步移除：浏览器可能在事件返回后才抓取快照
    const id = window.setTimeout(() => {
      animationTimers.delete(id)
      image.remove()
    }, 0)
    animationTimers.add(id)
  } catch {
    image.remove()
  }
}

function onCardDragStart(card: TCard, event: DragEvent) {
  const element = event.currentTarget as HTMLElement
  dragCardId.value = card.id
  // offsetHeight 含边框不含外间距；测量失败（测试环境）时保留 0，仅退化掉动画
  dragCardHeight.value = Math.max(0, Math.round(element.offsetHeight))
  dragSourceFrame.value = { height: dragCardHeight.value + CARD_SLOT_GAP_PX, paddingBottom: CARD_SLOT_GAP_PX, opacity: 1 }
  event.dataTransfer?.setData('text/plain', card.id)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    setCardDragImage(element, event.dataTransfer, { x: event.clientX, y: event.clientY })
  }
  // 拖影已在上方同步锁定，再启动源卡槽位塌陷
  clearSourceAnimation()
  cancelSourceAnimation = animateDragSlot(
    dragSourceFrame.value,
    { height: 0, paddingBottom: 0, opacity: 0 },
    160,
    (frame) => {
      dragSourceFrame.value = frame
    },
    () => {},
    { reducedMotion: reducedMotion.matches, ...(props.animationClock ?? {}) },
  )
}

/** 取消 / 无效松手：占位卡收缩移除，原卡片恢复占位（真实数组从未动过） */
function onCardDragEnd() {
  hideDropPlaceholder()
  clearSourceAnimation()
  // 从当前高度恢复，避免取消发生在塌陷中途时卡片跳变
  const frame = dragSourceFrame.value
  cancelSourceAnimation = animateDragSlot(
    frame,
    { height: dragCardHeight.value + CARD_SLOT_GAP_PX, paddingBottom: CARD_SLOT_GAP_PX, opacity: 1 },
    160,
    (nextFrame) => {
      dragSourceFrame.value = nextFrame
    },
    () => {
      dragCardId.value = null
      dragCardHeight.value = 0
      cancelSourceAnimation = null
    },
    { reducedMotion: reducedMotion.matches, ...(props.animationClock ?? {}) },
  )
  cancelAnimationTimers()
}

function isDropAllowed(columnKey: string): boolean {
  if (!dragCardId.value) {
    return false
  }
  return props.canDropCard?.(dragCardId.value, columnKey) ?? true
}

/** 更新落点：同一位置只更新指针；换位置则旧卡退场、新卡独立从 0 展开 */
function showDropPlaceholder(slot: DropSlot) {
  const current = dropSlot.value
  if (current?.columnKey === slot.columnKey && current.insertionIndex === slot.insertionIndex) {
    return
  }
  hideDropPlaceholder()
  dropSlot.value = slot
  const key = ++nextDropPlaceholderKey
  const placeholder: DropPlaceholder = { ...slot, key, frame: zeroFrame() }
  activeDropPlaceholderKey.value = key
  dropPlaceholders.value.push(placeholder)
  clearPlaceholderAnimation(key)
  const cancel = animateDragSlot(
    zeroFrame(),
    { ...fullFrame(), opacity: 0 },
    PLACEHOLDER_COLLAPSE_MS,
    (frame) => {
      writePlaceholderFrame(key, frame)
    },
    () => {
      clearPlaceholderAnimation(key)
      const current = dropPlaceholders.value.find((item) => item.key === key)
      if (!current) {
        return
      }
      // 用户要求先长高再淡入：高度动画完成后才启动独立的透明度时间轴
      cancelPlaceholderFades.set(key, animateDragSlot(
        current.frame,
        { ...current.frame, opacity: 1 },
        120,
        (frame) => writePlaceholderFrame(key, frame),
        () => cancelPlaceholderFades.delete(key),
        { reducedMotion: reducedMotion.matches, ...(props.animationClock ?? {}) },
      ))
    },
    { reducedMotion: reducedMotion.matches, ...(props.animationClock ?? {}) },
  )
  cancelPlaceholderAnimations.set(key, cancel)
}

/** 移出可放区域：占位卡从当前高度收缩，过渡结束后再卸载节点 */
function hideDropPlaceholder() {
  dropSlot.value = null
  const activeKey = activeDropPlaceholderKey.value
  activeDropPlaceholderKey.value = null
  if (activeKey === null) {
    return
  }
  const active = dropPlaceholders.value.find((item) => item.key === activeKey)
  if (!active) {
    return
  }
  clearPlaceholderAnimation(activeKey)
  const cancel = animateDragSlot(
    active.frame,
    zeroFrame(),
    PLACEHOLDER_COLLAPSE_MS,
    (frame) => {
      active.frame = frame
    },
    () => {
      removeDropPlaceholder(activeKey)
    },
    { reducedMotion: reducedMotion.matches, ...(props.animationClock ?? {}) },
  )
  cancelPlaceholderAnimations.set(activeKey, cancel)
}

/** 列级 dragover：不依赖子卡片事件，空白区/空列与卡片一样有明确落点 */
function onColumnDragOver(column: { key: string; cards: readonly TCard[] }, event: DragEvent) {
  if (!dragCardId.value || !isDropAllowed(column.key)) {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none'
    }
    hideDropPlaceholder()
    return
  }

  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }

  const list = (event.currentTarget as Element).querySelector('[data-board-cards]')
  const rects = Array.from(list?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])
    .filter((element) => element.dataset.cardId !== dragCardId.value)
    .map((element) => element.getBoundingClientRect())
  const insertionIndex = boardDropInsertionIndex(rects, event.clientY)
  showDropPlaceholder({ columnKey: column.key, insertionIndex })
}

/** 拖离看板（含拖出窗口）：清掉最后的落点占位；列间移动不经过这里 */
function onBoardDragLeave(event: DragEvent) {
  const related = event.relatedTarget
  if (related instanceof Node && boardRoot.value?.contains(related)) {
    return
  }
  hideDropPlaceholder()
}

function onColumnDrop(column: { key: string; cards: readonly TCard[] }, event: DragEvent) {
  event.preventDefault()
  const id = dragCardId.value
  const slot = dropSlot.value
  const dropAllowed = isDropAllowed(column.key)
  // 先清拖拽态再上抛：调用方乐观重排与占位卸载同帧渲染，真实卡片直接接管位置
  dragCardId.value = null
  dragCardHeight.value = 0
  dropSlot.value = null
  dropPlaceholders.value = []
  activeDropPlaceholderKey.value = null
  dragSourceFrame.value = { height: 0, paddingBottom: CARD_SLOT_GAP_PX, opacity: 1 }
  cancelDragAnimations()

  if (!id || !slot || slot.columnKey !== column.key || !dropAllowed) {
    return
  }

  const position = boardMovePositionForInsertion(column.cards, id, slot.insertionIndex)
  if (position.beforeId !== undefined) {
    emit('moveCard', id, column.key, null, position.beforeId)
  } else {
    emit('moveCard', id, column.key, position.afterId ?? null)
  }
}

/** 一列的渲染项：真实卡片全保留；每个落点占位独立，允许旧位置收缩、新位置展开 */
function columnItems(column: { key: string; cards: readonly TCard[] }): BoardRenderItem[] {
  const items: BoardRenderItem[] = []
  const placeholders = dropPlaceholders.value
    .filter((placeholder) => placeholder.columnKey === column.key)
    .sort((a, b) => a.insertionIndex - b.insertionIndex)
  let insertionIndex = 0

  for (const card of column.cards) {
    if (dragCardId.value !== null && card.id === dragCardId.value) {
      items.push({ kind: 'card', card, isDragSource: true })
      continue
    }
    for (const placeholder of placeholders.filter((item) => item.insertionIndex === insertionIndex)) {
      items.push({ kind: 'placeholder', placeholder })
    }
    items.push({ kind: 'card', card, isDragSource: false })
    insertionIndex += 1
  }
  for (const placeholder of placeholders.filter((item) => item.insertionIndex === insertionIndex)) {
    items.push({ kind: 'placeholder', placeholder })
  }
  return items
}

/** 被拖卡片的槽位样式：高度、间距和透明度由同一时间轴驱动 */
function dragSourceSlotStyle(): Record<string, string> | undefined {
  if (!dragCardId.value) {
    return undefined
  }
  return {
    height: `${Math.max(0, dragSourceFrame.value.height)}px`,
    paddingBottom: `${Math.max(0, dragSourceFrame.value.paddingBottom)}px`,
  }
}

/** 占位卡槽位样式：每个落点持有独立帧，展开/收回均可看到中间高度 */
function dropPlaceholderSlotStyle(placeholder: DropPlaceholder): Record<string, string> {
  return {
    height: `${placeholder.frame.height}px`,
    paddingBottom: `${placeholder.frame.paddingBottom}px`,
  }
}
</script>

<template>
  <div
    ref="boardRoot"
    class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-white text-gray-800"
    @dragleave="onBoardDragLeave"
  >
    <!-- 顶栏：结构与其他分类中央头部一致（刷新在左侧标题行，新建在侧栏摘要卡下方） -->
    <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex items-center gap-2">
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
        @dragover="onColumnDragOver(column, $event)"
        @drop.prevent="onColumnDrop(column, $event)"
      >
        <header class="flex items-center gap-2 px-3 py-2.5">
          <h2 class="text-xs font-semibold text-gray-600">{{ column.label }}</h2>
          <span class="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-500">{{ column.cards.length }}</span>
        </header>

        <!-- 间距由每个卡片槽自带（塌陷/展开时高度与间距一起动画），容器不用 gap -->
        <div
          class="flex min-h-24 flex-1 flex-col overflow-y-auto px-2 pb-2"
          data-board-cards
        >
          <p v-if="column.cards.length === 0" class="px-1 py-4 text-center text-xs text-gray-400">
            {{ emptyColumnText ?? '拖卡片到这里' }}
          </p>

          <template v-for="item in columnItems(column)" :key="item.kind === 'placeholder' ? `board-drop-placeholder-${item.placeholder.key}` : item.card.id">
            <!-- 落点占位：每个落点独立，旧位置收缩、新位置从 0 展开；不参与命中 -->
            <div
              v-if="item.kind === 'placeholder'"
              :class="['board-card-slot board-card-slot--drop', item.placeholder.frame.height > 0 ? 'is-expanded' : '']"
              :style="dropPlaceholderSlotStyle(item.placeholder)"
              :data-drop-placeholder-key="item.placeholder.key"
              aria-hidden="true"
            >
              <div
                class="rounded-md border-2 border-dashed border-gray-300 bg-gray-50"
                :style="{ height: `${Math.max(dragCardHeight, 0)}px`, opacity: item.placeholder.frame.opacity }"
                :data-testid="`${testidPrefix}-drop-placeholder`"
              />
            </div>

            <div
              v-else
              :class="['board-card-slot', item.isDragSource ? 'board-card-slot--dragged' : '']"
              :style="item.isDragSource ? dragSourceSlotStyle() : undefined"
            >
              <article
                :class="[
                  'group relative cursor-pointer rounded-md border bg-white p-2.5 transition-colors hover:border-gray-300 focus-visible:outline-2 focus-visible:outline-gray-900',
                  item.isDragSource ? 'opacity-0' : '',
                  selectedCardId === item.card.id ? 'border-gray-900' : 'border-gray-200',
                ]"
                draggable="true"
                tabindex="0"
                :data-testid="`${testidPrefix}-card`"
                :data-card-id="item.card.id"
                @click="emit('openCard', item.card.id)"
                @keydown.enter.prevent="emit('openCard', item.card.id)"
                @keydown.space.prevent="emit('openCard', item.card.id)"
                @dragstart="onCardDragStart(item.card, $event)"
                @dragend="onCardDragEnd"
              >
                <!-- 卡片内容：领域注入（标题/摘要/时间或伏笔的埋设章节与回收窗口） -->
                <slot name="card-content" :card="item.card" />
              </article>
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 卡片槽 owns 卡片高度与下方间距；逐帧值由 drag-slot-animation 提供，不走 CSS 时钟 */
.board-card-slot {
  padding-bottom: 0.5rem;
  overflow: hidden;
}

.board-card-slot--drop {
  pointer-events: none;
}
</style>
