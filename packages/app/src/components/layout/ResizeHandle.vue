<script setup lang="ts">
import { onUnmounted, ref } from 'vue'

/**
 * 面板拖拽改宽手柄（R7）。
 *
 * - 绝对定位在父容器左侧边缘，4px 竖条
 * - mousedown 记录起点 x 和起始宽度，document mousemove 实时计算目标宽度
 * - 手柄在面板左侧、面板在右侧，鼠标左移（deltaX 负）面板应变宽
 *   因此目标宽度 = startWidth - deltaX（基于起始宽度，不依赖当前 width 做累加）
 * - 拖拽期间锁定 body 光标与文本选中，避免误触
 * - 双击触发 reset，恢复默认宽度
 * - 仅 lg: 断点以上渲染（移动端浮层全屏，无需拖拽）
 */
const props = defineProps<{
  /** 拖拽起始时的面板宽度，用于按位移等量计算 */
  startWidth: number
}>()

const emit = defineEmits<{
  /** mousedown：通知父组件进入拖拽态（用于暂停过渡动画） */
  dragstart: []
  /** mousemove：发出目标宽度（基于 mousedown 时的 startWidth 累计位移计算），父组件直接应用 */
  drag: [width: number]
  /** mouseup：拖拽结束（恢复过渡动画） */
  dragend: []
  /** 双击重置到默认宽度 */
  reset: []
}>()

const isDragging = ref(false)
let startX = 0
let startWidth = 0

function handleMousedown(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  startX = e.clientX
  startWidth = props.startWidth
  emit('dragstart')

  document.body.classList.add('cursor-col-resize', 'select-none')

  document.addEventListener('mousemove', handleMousemove)
  document.addEventListener('mouseup', handleMouseup)
}

function handleMousemove(e: MouseEvent) {
  if (!isDragging.value) return
  const deltaX = e.clientX - startX
  // 鼠标左移 deltaX 为负，面板应变宽，故目标宽度 = 起始宽度 - deltaX
  emit('drag', startWidth - deltaX)
}

function handleMouseup() {
  isDragging.value = false
  document.body.classList.remove('cursor-col-resize', 'select-none')
  document.removeEventListener('mousemove', handleMousemove)
  document.removeEventListener('mouseup', handleMouseup)
  emit('dragend')
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleMousemove)
  document.removeEventListener('mouseup', handleMouseup)
  document.body.classList.remove('cursor-col-resize', 'select-none')
})
</script>

<template>
  <div
    class="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize -translate-x-1/2 bg-transparent transition-colors hover:bg-blue-400 lg:block"
    :class="{ 'bg-blue-400': isDragging }"
    @mousedown="handleMousedown"
    @dblclick="emit('reset')"
  />
</template>
