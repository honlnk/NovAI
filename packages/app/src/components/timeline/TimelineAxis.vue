<script setup lang="ts">
/**
 * 时间轴甘特视图（时间轴甘特图改造计划 §三、§四）：
 * - 横轴 = 列表顺序：每个时间标记占一列（end 只占列，即区间横条右端）；表头不写列序号，
 *   只在事件起始列写世界观日期（明确时间），无日期的列留空；日期放不下时排布自动加宽列宽；
 * - 点事件 = 菱形 + 右侧标题；区间事件 = 从开始列画到结束列的横条，标题写在条内，
 *   比横条长时越过右端继续写（横条长度不变）；
 * - 行由纯函数 layoutTimelineGantt 动态排布（最多 6 行，放不下加宽列宽），任何数据变化整体重排；
 * - 缩放滑块 = 最小列宽（父层注入），实际列宽只会更宽；
 * - 平移：鼠标在轴上按住拖动即横纵平移（移动超过阈值后不再触发点选）；触屏走原生滚动；
 * - 缩放：滚轮纵向滚动、Ctrl/⌘ + 滚轮、触控板双指捏合（浏览器以 ctrlKey 滚轮事件上报）
 *   都改最小列宽，并以指针下的列为锚保持位置不动；横向滚轮（Shift + 滚轮、触控板左右滑）
 *   仍是原生横向滚动；
 * - 只读：点击选中事件，不提供拖拽调整顺序（甘特计划决策 6）；相对时间与锚点不上图。
 *
 * 哑组件：条目与命中态由 store 产出，这里只测宽、排布、绘制。
 */
import { computed, ref, watch } from 'vue'

import type { TimelineAxisNode } from '../../stores/timeline'
import {
  GANTT_DATE_FONT,
  GANTT_PAD_X,
  GANTT_TITLE_FONT,
  layoutTimelineGantt,
  type GanttEntry,
  type GanttLayoutItem,
  type GanttMeasure,
} from '../../stores/timeline-gantt'

const props = defineProps<{
  /** 全部标记（每个一列）：决定列数 */
  nodes: TimelineAxisNode[]
  /** 甘特条目（point / start 各一条） */
  entries: GanttEntry[]
  /** 最小列宽（缩放滑块） */
  stepPx: number
  selectedEventId: string
}>()

const emit = defineEmits<{
  'select-event': [eventId: string]
  /** 滚轮/捏合缩放：新的最小列宽（父层写回滑块值） */
  zoom: [stepPx: number]
}>()

/* ---------- 测宽（canvas measureText；无 canvas 环境按字符估算） ---------- */

let measureContext: CanvasRenderingContext2D | null | undefined
const measureCache = new Map<string, number>()

function fontFamily(): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return 'sans-serif'
  }
  return getComputedStyle(document.body).fontFamily || 'sans-serif'
}

function estimateWidth(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) {
    width += char.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6
  }
  return width
}

const measure: GanttMeasure = (text, fontSize) => {
  const key = `${fontSize}\u0000${text}`
  const cached = measureCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  if (measureContext === undefined) {
    try {
      measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      measureContext = null
    }
  }
  let width: number
  if (measureContext) {
    measureContext.font = `${fontSize}px ${fontFamily()}`
    width = measureContext.measureText(text).width
  } else {
    width = estimateWidth(text, fontSize)
  }
  measureCache.set(key, width)
  return width
}

/* ---------- 排布与几何 ---------- */

const HEADER_H = 24
const ROW_H = 34
const BOTTOM_PAD = 8

const layout = computed(() => layoutTimelineGantt(props.entries, props.nodes.length, { minStep: props.stepPx, measure }))

const svgWidth = computed(() => layout.value.width)
const svgHeight = computed(() => HEADER_H + layout.value.rowCount * ROW_H + BOTTOM_PAD)

function rowTop(row: number): number {
  return HEADER_H + row * ROW_H
}

function isSelected(item: GanttLayoutItem): boolean {
  return item.eventId === props.selectedEventId
}

function tooltip(item: GanttLayoutItem): string {
  const kind = item.kind === 'span' ? '区间 ' : ''
  return `${kind}${item.title}${item.dateLabel ? `（${item.dateLabel}）` : '（未填日期）'}`
}

function select(item: GanttLayoutItem) {
  emit('select-event', item.eventId)
}

/** 菱形顶点（中心 cx/cy，半对角 6） */
function diamondPoints(cx: number, cy: number, half = 6): string {
  return `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`
}


/* ---------- 拖动平移 ---------- */

const containerRef = ref<HTMLDivElement | null>(null)

/** 移动超过该距离才算平移（以下仍按点击处理） */
const PAN_THRESHOLD = 4

type PanState = { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean }
const pan = ref<PanState | null>(null)
/** 刚结束一次平移：吞掉紧随其后的 click，避免松手时误选条目 */
let suppressClick = false

function onPointerDown(event: PointerEvent) {
  // 触屏/触控笔走原生滚动；只处理鼠标左键
  if (event.pointerType !== 'mouse' || event.button !== 0 || !containerRef.value) {
    return
  }
  suppressClick = false
  pan.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: containerRef.value.scrollLeft,
    scrollTop: containerRef.value.scrollTop,
    moved: false,
  }
}

function onPointerMove(event: PointerEvent) {
  const state = pan.value
  const container = containerRef.value
  if (!state || !container || event.pointerId !== state.pointerId) {
    return
  }
  const dx = event.clientX - state.startX
  const dy = event.clientY - state.startY
  if (!state.moved) {
    if (Math.abs(dx) <= PAN_THRESHOLD && Math.abs(dy) <= PAN_THRESHOLD) {
      return
    }
    state.moved = true
    // 进入平移后才捕获指针：未移动的按下-松开仍是普通点击，落在条目上
    container.setPointerCapture?.(event.pointerId)
  }
  container.scrollLeft = state.scrollLeft - dx
  container.scrollTop = state.scrollTop - dy
}

function onPointerEnd(event: PointerEvent) {
  const state = pan.value
  if (!state || event.pointerId !== state.pointerId) {
    return
  }
  if (state.moved) {
    suppressClick = true
    containerRef.value?.releasePointerCapture?.(event.pointerId)
  }
  pan.value = null
}

function onClickCapture(event: MouseEvent) {
  if (suppressClick) {
    suppressClick = false
    event.stopPropagation()
    event.preventDefault()
  }
}

/* ---------- 滚轮 / 捏合缩放（以指针下的列为锚） ---------- */

const ZOOM_MIN = 48
const ZOOM_MAX = 240
/** 单次事件 deltaY 截断（鼠标一格约 100，捏合约 1–10）与灵敏度：鼠标一格约缩放 17% */
const ZOOM_DELTA_CAP = 30
const ZOOM_SENSITIVITY = 0.006

/** 连续缩放中的未取整列宽（见 onWheel） */
let zoomFloat: number | null = null

/** 待恢复的锚点：缩放前指针下的「列坐标」与指针在容器内的横向偏移 */
let zoomAnchor: { column: number; offsetX: number } | null = null

function normalizedDeltaY(event: WheelEvent): number {
  // deltaMode 1 = 行、2 = 页：换算成像素量级
  return event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY
}

function onWheel(event: WheelEvent) {
  const container = containerRef.value
  if (!container || props.nodes.length === 0) {
    return
  }
  const pinchOrModifier = event.ctrlKey || event.metaKey
  // 横向为主的滚动（Shift + 滚轮、触控板左右滑）保持原生横向滚动
  if (!pinchOrModifier && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    return
  }
  const deltaY = normalizedDeltaY(event)
  if (deltaY === 0) {
    return
  }
  // 接管：阻止页面滚动与浏览器自身的 Ctrl + 滚轮页面缩放
  event.preventDefault()

  const current = layout.value.step
  // 累计小数部分：慢速捏合每次只有 1px 级 deltaY，逐次取整会被吃掉、永远缩不动；
  // 只要实际列宽仍跟随上次缩放（相差不到 1px），就在上次的小数值上继续累计
  const base = zoomFloat !== null && Math.abs(zoomFloat - current) < 1 ? zoomFloat : current
  const capped = Math.max(-ZOOM_DELTA_CAP, Math.min(ZOOM_DELTA_CAP, deltaY))
  zoomFloat = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, base * Math.exp(-capped * ZOOM_SENSITIVITY)))
  const next = Math.round(zoomFloat)
  if (next === props.stepPx) {
    return
  }
  const rect = container.getBoundingClientRect()
  const offsetX = event.clientX - rect.left
  zoomAnchor = {
    column: (container.scrollLeft + offsetX - GANTT_PAD_X) / current,
    offsetX,
  }
  emit('zoom', next)
}

// 实际列宽变化后（重排完成、DOM 已更新）把锚点列滚回指针下方
watch(
  () => layout.value.step,
  (step) => {
    const container = containerRef.value
    if (!zoomAnchor || !container) {
      return
    }
    container.scrollLeft = Math.max(0, GANTT_PAD_X + zoomAnchor.column * step - zoomAnchor.offsetX)
    zoomAnchor = null
  },
  { flush: 'post' },
)
</script>

<template>
  <div
    ref="containerRef"
    :class="['timeline-axis h-full w-full overflow-auto', nodes.length > 0 ? (pan?.moved ? 'cursor-grabbing [&_*]:cursor-grabbing' : 'cursor-grab') : '']"
    data-testid="timeline-axis-scroll"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerEnd"
    @pointercancel="onPointerEnd"
    @click.capture="onClickCapture"
    @wheel="onWheel"
  >
    <svg
      v-if="nodes.length > 0"
      :width="svgWidth"
      :height="svgHeight"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
      class="block select-none"
      data-testid="timeline-axis-svg"
    >
      <!-- 表头：世界观日期（事件起始列；无日期的列留空） -->
      <text
        v-for="label in layout.labels"
        :key="`date-${label.index}`"
        :data-testid="`timeline-date-${label.index}`"
        :x="label.x"
        :y="15"
        text-anchor="middle"
        :font-size="GANTT_DATE_FONT"
        fill="#6b7280"
        class="pointer-events-none"
      >{{ label.text }}</text>

      <!-- 行分隔线 -->
      <line
        v-for="row in layout.rowCount"
        :key="`row-${row}`"
        x1="0"
        :y1="rowTop(row - 1) + 0.5"
        :x2="svgWidth"
        :y2="rowTop(row - 1) + 0.5"
        stroke="#e5e7eb"
        stroke-dasharray="3 3"
      />

      <!-- 条目 -->
      <g
        v-for="item in layout.items"
        :key="item.eventId"
        :data-testid="`timeline-item-${item.eventId}`"
        :data-row="item.row"
        :opacity="item.matched ? 1 : 0.25"
        class="cursor-pointer outline-none"
        role="button"
        tabindex="0"
        :aria-label="tooltip(item)"
        :aria-pressed="isSelected(item)"
        @click="select(item)"
        @keydown.enter.prevent="select(item)"
        @keydown.space.prevent="select(item)"
      >
        <title>{{ tooltip(item) }}</title>

        <!-- 区间：横条从开始列到结束列 -->
        <template v-if="item.kind === 'span'">
          <rect
            :x="item.barLeft"
            :y="rowTop(item.row) + 5"
            :width="item.barRight - item.barLeft"
            height="24"
            rx="6"
            :fill="isSelected(item) ? '#c7d2fe' : '#e0e7ff'"
            :stroke="isSelected(item) ? '#4f46e5' : '#a5b4fc'"
            :stroke-width="isSelected(item) ? 2 : 1"
          />
          <!-- 透明命中区：越出横条的标题也可点 -->
          <rect :x="item.left" :y="rowTop(item.row) + 5" :width="item.right - item.left" height="24" fill="transparent" />
          <text :x="item.barLeft + 8" :y="rowTop(item.row) + 21" font-size="12" fill="#3730a3" :font-weight="isSelected(item) ? 600 : 400" class="pointer-events-none">{{ item.title }}</text>
        </template>

        <!-- 点：菱形 + 右侧标题 -->
        <template v-else>
          <rect :x="item.left" :y="rowTop(item.row) + 5" :width="item.right - item.left" height="24" fill="transparent" />
          <circle v-if="isSelected(item)" :cx="item.x" :cy="rowTop(item.row) + 17" r="10" fill="none" stroke="#4f46e5" stroke-width="2" />
          <polygon :points="diamondPoints(item.x, rowTop(item.row) + 17)" :fill="isSelected(item) ? '#4f46e5' : '#6366f1'" />
          <text :x="item.x + 13" :y="rowTop(item.row) + 21" :font-size="GANTT_TITLE_FONT" :fill="isSelected(item) ? '#4f46e5' : '#374151'" :font-weight="isSelected(item) ? 600 : 400" class="pointer-events-none">{{ item.title }}</text>
        </template>
      </g>
    </svg>

    <!-- 空轴兜底（弹窗空态之外：账本只有 issue、没有任何合法标记时）；不渲染 SVG，无残留线 -->
    <p v-else class="px-4 py-6 text-center text-xs text-gray-400">时间轴为空；新建事件后在此按故事内顺序显示。</p>
  </div>
</template>
