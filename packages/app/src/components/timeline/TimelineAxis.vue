<script setup lang="ts">
/**
 * 时间轴 SVG（时间线 JSON 化施工计划 §9.4）：全部合法标记沿横轴等距落位——
 * - 点事件画轴上圆点、区间事件画轨道横带（轨道由 store 贪心分配，重叠区间分道）；
 * - 携带详情的标记下挂标题与时间角标（明确时间或相对时间摘要）；
 * - 相对时间锚画轴下虚线箭头链；
 * - 缩放 = 相邻标记像素步距（父层注入）；平移 = 容器原生横向滚动；
 * - 拖拽标记落位：up 时换算为列表空隙序号交给父层（领域层校验配对约束）。
 *
 * 哑组件：渲染模型（matched/dimmed）由 store 产出，这里只画。
 */
import { computed, ref } from 'vue'

import type { TimelineAxisNode } from '../../stores/timeline'

const props = defineProps<{
  nodes: TimelineAxisNode[]
  bands: Array<{ eventId: string; title: string; startIndex: number; endIndex: number; lane: number; dimmed: boolean }>
  laneCount: number
  links: Array<{ fromIndex: number; toIndex: number; eventId: string }>
  stepPx: number
  selectedEventId: string
}>()

const emit = defineEmits<{
  'select-event': [eventId: string]
  'move-marker': [markerId: string, targetIndex: number]
}>()

/* ---------- 布局常量与几何 ---------- */

const PAD_LEFT = 90
const PAD_RIGHT = 90
const LANE_H = 34
const TOP_PAD = 28
/** 轴下区域：标题 + 时间角标 + 锚链带 */
const BELOW_AXIS = 118

const axisY = computed(() => TOP_PAD + props.laneCount * LANE_H + 14)
const svgWidth = computed(() => {
  const last = props.nodes.length - 1
  return last <= 0 ? PAD_LEFT + PAD_RIGHT : PAD_LEFT + last * props.stepPx + PAD_RIGHT
})
const svgHeight = computed(() => axisY.value + BELOW_AXIS)

function x(index: number): number {
  return PAD_LEFT + index * props.stepPx
}

function bandY(lane: number): number {
  return axisY.value - 22 - (lane + 1) * LANE_H
}

/** 按像素宽度截断标题（SVG 文本无 ellipsis，手动截） */
function truncate(title: string, maxWidth: number): string {
  const max = Math.max(2, Math.floor(maxWidth / 13))
  return title.length > max ? `${title.slice(0, Math.max(1, max - 1))}…` : title
}

/* ---------- 交互：点击选中 + 拖拽落位 ---------- */

type DragState = {
  markerId: string
  index: number
  startX: number
  startY: number
  currentX: number
  moved: boolean
}

const drag = ref<DragState | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)

/** 指针横坐标 → 列表空隙序号（0..n；空隙 i 在标记 i-1 与 i 之间） */
function gapIndexAt(clientX: number): number {
  const rect = svgRef.value?.getBoundingClientRect()
  if (!rect) {
    return 0
  }
  const local = clientX - rect.left
  return Math.max(0, Math.min(props.nodes.length, Math.round((local - PAD_LEFT) / props.stepPx + 0.5)))
}

const caretIndex = computed(() => (drag.value ? gapIndexAt(drag.value.currentX) : -1))

function caretX(index: number): number {
  return index <= 0
    ? PAD_LEFT - props.stepPx / 2
    : index >= props.nodes.length
      ? x(props.nodes.length - 1) + props.stepPx / 2
      : PAD_LEFT + (index - 0.5) * props.stepPx
}

function onMarkerDown(event: PointerEvent, node: TimelineAxisNode) {
  if (event.button !== 0) {
    return
  }
  svgRef.value?.setPointerCapture(event.pointerId)
  drag.value = {
    markerId: node.marker.id,
    index: node.ordinal - 1,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    moved: false,
  }
}

function onSvgMove(event: PointerEvent) {
  const state = drag.value
  if (!state) {
    return
  }
  state.currentX = event.clientX
  if (Math.abs(event.clientX - state.startX) > 4 || Math.abs(event.clientY - state.startY) > 4) {
    state.moved = true
  }
}

function onSvgUp() {
  const state = drag.value
  drag.value = null
  if (!state) {
    return
  }
  if (!state.moved) {
    // 未拖动 = 点击：选中事件（end 标记也回指事件）
    const node = props.nodes[state.index]
    if (node?.eventId) {
      emit('select-event', node.eventId)
    }
    return
  }
  emit('move-marker', state.markerId, gapIndexAt(state.currentX))
}

function isDragged(node: TimelineAxisNode): boolean {
  return drag.value?.markerId === node.marker.id && drag.value.moved
}

function isSelected(node: TimelineAxisNode): boolean {
  return Boolean(node.eventId) && node.eventId === props.selectedEventId
}
</script>

<template>
  <div class="timeline-axis h-full w-full overflow-x-auto overflow-y-hidden">
    <svg
      ref="svgRef"
      :width="svgWidth"
      :height="svgHeight"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
      class="block select-none"
      data-testid="timeline-axis-svg"
      @pointermove="onSvgMove"
      @pointerup="onSvgUp"
      @pointercancel="onSvgUp"
    >
      <!-- 区间横带（轨道自上而下编号，lane 0 最贴近轴） -->
      <g v-for="band in bands" :key="`band-${band.eventId}`" class="cursor-pointer" :opacity="band.dimmed ? 0.25 : 1" @pointerdown.stop.prevent="emit('select-event', band.eventId)">
        <rect
          :x="x(band.startIndex) + 7"
          :y="bandY(band.lane)"
          :width="Math.max(14, x(band.endIndex) - x(band.startIndex) - 14)"
          :height="22"
          rx="11"
          :fill="band.eventId === selectedEventId ? '#4f46e5' : '#c7d2fe'"
        />
        <text
          :x="(x(band.startIndex) + x(band.endIndex)) / 2"
          :y="bandY(band.lane) + 15"
          text-anchor="middle"
          class="pointer-events-none"
          :fill="band.eventId === selectedEventId ? '#ffffff' : '#3730a3'"
          font-size="12"
        >{{ truncate(band.title, x(band.endIndex) - x(band.startIndex) - 24) }}</text>
      </g>

      <!-- 横轴主线 -->
      <line :x1="PAD_LEFT - 40" :y1="axisY" :x2="svgWidth - PAD_RIGHT + 40" :y2="axisY" stroke="#d1d5db" stroke-width="2" />

      <!-- 相对时间锚链（轴下虚线箭头） -->
      <g v-for="(link, index) in links" :key="`link-${link.eventId}`" class="cursor-pointer" @pointerdown.stop.prevent="emit('select-event', link.eventId)">
        <path
          :d="`M ${x(link.fromIndex)} ${axisY + 10} Q ${(x(link.fromIndex) + x(link.toIndex)) / 2} ${axisY + 44 + (index % 3) * 10} ${x(link.toIndex)} ${axisY + 10}`"
          fill="none"
          stroke="#a5b4fc"
          stroke-width="1.5"
          stroke-dasharray="4 3"
        />
        <circle :cx="x(link.fromIndex)" :cy="axisY + 10" r="2.5" fill="#a5b4fc" />
        <circle :cx="x(link.toIndex)" :cy="axisY + 10" r="2.5" fill="#6366f1" />
        <title>相对时间锚链</title>
      </g>

      <!-- 标记位：点 = 圆点 / 区间开始 = 圆角方 / 区间结束 = 竖刻 -->
      <g
        v-for="node in nodes"
        :key="node.marker.id"
        :data-testid="`timeline-marker-${node.ordinal}`"
        :opacity="node.matched ? 1 : 0.25"
        :cursor="isDragged(node) ? 'grabbing' : 'grab'"
        @pointerdown.stop.prevent="onMarkerDown($event, node)"
      >
        <!-- 拖拽中的原位淡出 -->
        <g v-if="isDragged(node)" opacity="0.35">
          <circle v-if="node.marker.kind === 'point'" :cx="x(node.ordinal - 1)" :cy="axisY" r="7" fill="#6366f1" />
          <rect v-else-if="node.marker.kind === 'start'" :x="x(node.ordinal - 1) - 6" :y="axisY - 6" width="12" height="12" rx="3" fill="#6366f1" />
          <line v-else :x1="x(node.ordinal - 1)" :y1="axisY - 8" :x2="x(node.ordinal - 1)" :y2="axisY + 8" stroke="#6366f1" stroke-width="3" />
        </g>
        <template v-else>
          <!-- 选中环 -->
          <circle v-if="isSelected(node)" :cx="x(node.ordinal - 1)" :cy="axisY" r="12" fill="none" stroke="#4f46e5" stroke-width="2" class="pointer-events-none" />
          <circle v-if="node.marker.kind === 'point'" :cx="x(node.ordinal - 1)" :cy="axisY" r="6.5" :fill="node.eventId === selectedEventId ? '#4f46e5' : '#6366f1'" />
          <rect v-else-if="node.marker.kind === 'start'" :x="x(node.ordinal - 1) - 6" :y="axisY - 6" width="12" height="12" rx="3" :fill="node.eventId === selectedEventId ? '#4f46e5' : '#6366f1'" />
          <line v-else :x1="x(node.ordinal - 1)" :y1="axisY - 8" :x2="x(node.ordinal - 1)" :y2="axisY + 8" :stroke="node.eventId === selectedEventId ? '#4f46e5' : '#6366f1'" stroke-width="3" />
        </template>

        <!-- 携带详情的标记：序号 + 标题 + 时间角标（轴下） -->
        <template v-if="node.title !== null">
          <text :x="x(node.ordinal - 1)" :y="axisY - 18" text-anchor="middle" font-size="10" fill="#9ca3af" class="pointer-events-none">{{ node.ordinal }}</text>
          <text
            :x="x(node.ordinal - 1)"
            :y="axisY + 26"
            text-anchor="middle"
            font-size="12"
            :fill="node.eventId === selectedEventId ? '#4f46e5' : '#374151'"
            :font-weight="node.eventId === selectedEventId ? 600 : 400"
            class="pointer-events-none"
          >{{ truncate(node.title, stepPx - 6) }}</text>
          <text
            v-if="node.timeLabel"
            :x="x(node.ordinal - 1)"
            :y="axisY + 42"
            text-anchor="middle"
            font-size="10"
            fill="#9ca3af"
            class="pointer-events-none"
          >{{ truncate(node.timeLabel, stepPx - 4) }}</text>
        </template>

        <!-- 命中态角标（拖拽/悬停提示走原生 title） -->
        <title>{{ node.title ? `#${node.ordinal} ${node.title}` : `#${node.ordinal} 区间结束` }}</title>
      </g>

      <!-- 拖拽落位指示（空隙插入选中的竖线） -->
      <g v-if="drag && drag.moved && caretIndex >= 0" class="pointer-events-none">
        <line :x1="caretX(caretIndex)" :y1="TOP_PAD - 8" :x2="caretX(caretIndex)" :y2="axisY + 14" stroke="#4f46e5" stroke-width="2" stroke-dasharray="5 3" />
        <circle :cx="caretX(caretIndex)" :cy="axisY" r="4" fill="#4f46e5" />
      </g>
    </svg>

    <!-- 空轴兜底（弹窗空态之外：账本只有 issue、没有任何合法标记时） -->
    <p v-if="nodes.length === 0" class="px-4 py-6 text-center text-xs text-gray-400">账本中没有合法标记；异常条目见上方检查面板。</p>
  </div>
</template>
