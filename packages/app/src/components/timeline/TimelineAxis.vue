<script setup lang="ts">
/**
 * 时间轴甘特视图（时间轴甘特图改造计划 §三、§四）：
 * - 横轴 = 列表顺序：每个时间标记占一列（end 只占列，即区间横条右端），表头写列序号；
 * - 点事件 = 菱形 + 右侧标题；区间事件 = 从开始列画到结束列的横条，标题写在条内，
 *   比横条长时越过右端继续写（横条长度不变）；有明确时间时标题后跟灰色小字；
 * - 行由纯函数 layoutTimelineGantt 动态排布（最多 6 行，放不下加宽列宽），任何数据变化整体重排；
 * - 缩放滑块 = 最小列宽（父层注入），实际列宽只会更宽；平移 = 容器原生滚动；
 * - 只读：点击选中事件，不提供拖拽（甘特计划决策 6）；相对时间与锚点不上图。
 *
 * 哑组件：条目与命中态由 store 产出，这里只测宽、排布、绘制。
 */
import { computed } from 'vue'

import type { TimelineAxisNode } from '../../stores/timeline'
import {
  GANTT_DATE_FONT,
  GANTT_TITLE_FONT,
  ganttColumnX,
  layoutTimelineGantt,
  type GanttEntry,
  type GanttLayoutItem,
  type GanttMeasure,
} from '../../stores/timeline-gantt'

const props = defineProps<{
  /** 全部标记（每个一列）：决定列数与表头序号 */
  nodes: TimelineAxisNode[]
  /** 甘特条目（point / start 各一条） */
  entries: GanttEntry[]
  /** 最小列宽（缩放滑块） */
  stepPx: number
  selectedEventId: string
}>()

const emit = defineEmits<{
  'select-event': [eventId: string]
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

function columnX(index: number): number {
  return ganttColumnX(index, layout.value.step)
}

function isSelected(item: GanttLayoutItem): boolean {
  return item.eventId === props.selectedEventId
}

function tooltip(item: GanttLayoutItem): string {
  const kind = item.kind === 'span' ? `区间 #${item.startIndex + 1}–#${item.endIndex + 1}` : `#${item.startIndex + 1}`
  return `${kind} ${item.title}${item.dateLabel ? `（${item.dateLabel}）` : ''}`
}

function select(item: GanttLayoutItem) {
  emit('select-event', item.eventId)
}

/** 菱形顶点（中心 cx/cy，半对角 6） */
function diamondPoints(cx: number, cy: number, half = 6): string {
  return `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`
}

const TITLE_DATE_GAP = 6
</script>

<template>
  <div class="timeline-axis h-full w-full overflow-auto">
    <svg
      v-if="nodes.length > 0"
      :width="svgWidth"
      :height="svgHeight"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
      class="block select-none"
      data-testid="timeline-axis-svg"
    >
      <!-- 表头：列序号（每个时间标记一列） -->
      <text
        v-for="node in nodes"
        :key="`col-${node.marker.id}`"
        :x="columnX(node.ordinal - 1)"
        :y="15"
        text-anchor="middle"
        font-size="11"
        fill="#9ca3af"
        class="pointer-events-none"
      >{{ node.ordinal }}</text>

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
          <text :x="item.barLeft + 8" :y="rowTop(item.row) + 21" font-size="12" fill="#3730a3" :font-weight="isSelected(item) ? 600 : 400" class="pointer-events-none">{{ item.title }}<tspan v-if="item.dateLabel" :dx="TITLE_DATE_GAP" :font-size="GANTT_DATE_FONT" fill="#9ca3af" font-weight="400">{{ item.dateLabel }}</tspan></text>
        </template>

        <!-- 点：菱形 + 右侧标题 -->
        <template v-else>
          <rect :x="item.left" :y="rowTop(item.row) + 5" :width="item.right - item.left" height="24" fill="transparent" />
          <circle v-if="isSelected(item)" :cx="item.x" :cy="rowTop(item.row) + 17" r="10" fill="none" stroke="#4f46e5" stroke-width="2" />
          <polygon :points="diamondPoints(item.x, rowTop(item.row) + 17)" :fill="isSelected(item) ? '#4f46e5' : '#6366f1'" />
          <text :x="item.x + 13" :y="rowTop(item.row) + 21" :font-size="GANTT_TITLE_FONT" :fill="isSelected(item) ? '#4f46e5' : '#374151'" :font-weight="isSelected(item) ? 600 : 400" class="pointer-events-none">{{ item.title }}<tspan v-if="item.dateLabel" :dx="TITLE_DATE_GAP" :font-size="GANTT_DATE_FONT" fill="#9ca3af" font-weight="400">{{ item.dateLabel }}</tspan></text>
        </template>
      </g>
    </svg>

    <!-- 空轴兜底（弹窗空态之外：账本只有 issue、没有任何合法标记时）；不渲染 SVG，无残留线 -->
    <p v-else class="px-4 py-6 text-center text-xs text-gray-400">时间轴为空；新建事件后在此按故事内顺序显示。</p>
  </div>
</template>
