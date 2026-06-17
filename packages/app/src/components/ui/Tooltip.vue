<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

/**
 * 轻量 Tooltip 组件。
 *
 * - 包裹任意触发内容，hover / focus 时显示气泡
 * - 支持四向 preferredPlacement：top / bottom / left / right
 *   空间不足时自动翻转；交叉轴超出视口时自动 clamp
 * - 箭头始终指向 trigger 中心，随翻转/避让一起移动
 * - hoverable + hideDelay 允许鼠标移入气泡内部（适合气泡内含可交互内容）
 * - 滚动 / resize 期间实时跟随；卸载时清理所有定时器与监听
 * - 带 a11y：role="tooltip" 与 aria-describedby 联动
 *
 * 用法：
 *   <Tooltip text="提示文字"><button>按钮</button></Tooltip>
 *   <Tooltip text="说明" preferred-placement="right" multiline>...</Tooltip>
 */
const props = withDefaults(
  defineProps<{
    text: string
    /** 首选方向，空间不足时自动翻转 */
    preferredPlacement?: 'top' | 'bottom' | 'left' | 'right'
    /** 显示延迟（ms） */
    delay?: number
    /** 隐藏延迟（ms），便于鼠标移入气泡 */
    hideDelay?: number
    /** 是否允许鼠标移入气泡内部 */
    hoverable?: boolean
    /** 多行文本：自动换行并限制最大宽度 */
    multiline?: boolean
    /** 禁用 tooltip（不显示，但仍渲染 slot） */
    disabled?: boolean
  }>(),
  {
    preferredPlacement: 'bottom',
    delay: 0,
    hideDelay: 0,
    hoverable: false,
    multiline: false,
    disabled: false,
  },
)

const triggerRef = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)
const isVisible = ref(false)

let delayTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let isHovered = false

/** 翻转后的实际落点方向 */
const side = ref<'top' | 'bottom' | 'left' | 'right'>('bottom')
/** tooltip 左上角坐标 */
const pos = ref({ left: 0, top: 0 })
/** 箭头沿交叉轴的偏移（垂直落点时=left，水平落点时=top） */
const arrowOffset = ref(0)

// 为 a11y 生成稳定 id
const tooltipId = `tooltip-${Math.random().toString(36).slice(2, 9)}`

const tooltipStyle = computed(() => ({
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
}))

const isHorizontalSide = computed(() => side.value === 'left' || side.value === 'right')

// 箭头：方向决定贴边 + 三角朝向；交叉轴用 arrowOffset 定位
const arrowClass = computed(() => {
  const base = 'absolute border-4 border-transparent'
  switch (side.value) {
    case 'bottom':
      return `${base} bottom-full -translate-x-1/2 border-b-gray-800`
    case 'top':
      return `${base} top-full -translate-x-1/2 border-t-gray-800`
    case 'right':
      // tooltip 在 trigger 右侧，箭头朝左，贴 tooltip 左边
      return `${base} right-full -translate-y-1/2 border-r-gray-800`
    case 'left':
      // tooltip 在 trigger 左侧，箭头朝右，贴 tooltip 右边
      return `${base} left-full -translate-y-1/2 border-l-gray-800`
  }
})

const arrowStyle = computed(() =>
  isHorizontalSide.value
    ? { top: `${arrowOffset.value}px` }
    : { left: `${arrowOffset.value}px` },
)

function clearTimers() {
  if (delayTimer) {
    clearTimeout(delayTimer)
    delayTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

async function updatePosition() {
  isVisible.value = true
  await nextTick()

  if (!triggerRef.value || !tooltipRef.value) return

  const rect = triggerRef.value.getBoundingClientRect()
  const tooltipRect = tooltipRef.value.getBoundingClientRect()
  const vpW = window.innerWidth
  const vpH = window.innerHeight
  const margin = 8
  const gap = 8
  const width = tooltipRect.width
  const height = tooltipRect.height

  if (props.preferredPlacement === 'left' || props.preferredPlacement === 'right') {
    // —— 水平落点：tooltip 在 trigger 左/右侧，垂直方向跟随 trigger 中心 ——
    const triggerCenterY = rect.top + rect.height / 2
    const maxTop = Math.max(margin, vpH - height - margin)
    const top = Math.min(Math.max(margin, triggerCenterY - height / 2), maxTop)

    const fitsRight = rect.right + gap + width <= vpW - margin
    const fitsLeft = rect.left - gap - width >= margin
    const resolvedSide =
      props.preferredPlacement === 'right' ? (fitsRight ? 'right' : 'left') : fitsLeft ? 'left' : 'right'
    const left =
      resolvedSide === 'right' ? rect.right + gap : Math.max(margin, rect.left - gap - width)

    // 箭头跟随 trigger 垂直中心，clamp 在气泡上下两端
    const arrowMin = 12
    const arrowMax = Math.max(arrowMin, height - arrowMin)
    const offset = Math.min(Math.max(arrowMin, triggerCenterY - top), arrowMax)

    side.value = resolvedSide
    pos.value = { left, top }
    arrowOffset.value = offset
  } else {
    // —— 垂直落点：tooltip 在 trigger 上/下方，水平方向跟随 trigger 中心 ——
    const triggerCenterX = rect.left + rect.width / 2
    const maxLeft = Math.max(margin, vpW - width - margin)
    const left = Math.min(Math.max(margin, triggerCenterX - width / 2), maxLeft)

    const fitsBottom = rect.bottom + gap + height <= vpH - margin
    const fitsTop = rect.top - height - gap >= margin
    const resolvedSide =
      props.preferredPlacement === 'top' ? (fitsTop ? 'top' : 'bottom') : fitsBottom ? 'bottom' : 'top'
    const top =
      resolvedSide === 'bottom' ? rect.bottom + gap : Math.max(margin, rect.top - height - gap)

    const arrowMin = 12
    const arrowMax = Math.max(arrowMin, width - arrowMin)
    const offset = Math.min(Math.max(arrowMin, triggerCenterX - left), arrowMax)

    side.value = resolvedSide
    pos.value = { left, top }
    arrowOffset.value = offset
  }
}

function showTooltip() {
  if (props.disabled || !props.text) return
  isHovered = true
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }

  if (isVisible.value) {
    updatePosition()
    return
  }

  if (props.delay > 0) {
    if (delayTimer) clearTimeout(delayTimer)
    delayTimer = setTimeout(() => {
      if (isHovered) updatePosition()
    }, props.delay)
  } else {
    updatePosition()
  }
}

function hideTooltip() {
  isHovered = false
  if (delayTimer) {
    clearTimeout(delayTimer)
    delayTimer = null
  }

  if (props.hideDelay > 0) {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!isHovered) isVisible.value = false
      hideTimer = null
    }, props.hideDelay)
    return
  }

  isVisible.value = false
}

// 视口滚动 / resize 期间实时跟随（capture 捕获任意可滚动容器）
function handleViewportChange() {
  if (isVisible.value) updatePosition()
}

function bindListeners() {
  window.addEventListener('scroll', handleViewportChange, true)
  window.addEventListener('resize', handleViewportChange)
}

function unbindListeners() {
  window.removeEventListener('scroll', handleViewportChange, true)
  window.removeEventListener('resize', handleViewportChange)
}

// 随可见性挂载/卸载监听，避免不可见时无谓计算
watch(isVisible, (v) => {
  if (v) bindListeners()
  else unbindListeners()
})

onUnmounted(() => {
  clearTimers()
  unbindListeners()
})
</script>

<template>
  <span
    ref="triggerRef"
    class="inline-flex max-w-full"
    :aria-describedby="isVisible && text ? tooltipId : undefined"
    @focusin="showTooltip"
    @focusout="hideTooltip"
    @mouseenter="showTooltip"
    @mouseleave="hideTooltip"
  >
    <slot />
  </span>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <span
        v-if="isVisible && text"
        :id="tooltipId"
        ref="tooltipRef"
        role="tooltip"
        class="fixed z-50 max-w-[calc(100vw-16px)] rounded-lg bg-gray-800 px-3 py-1.5 text-[11px] leading-snug text-white shadow-lg"
        :class="[
          hoverable ? 'pointer-events-auto' : 'pointer-events-none',
          multiline
            ? 'w-max max-w-80 whitespace-pre-wrap break-words'
            : 'whitespace-nowrap',
        ]"
        :style="tooltipStyle"
        @mouseenter="hoverable ? showTooltip() : undefined"
        @mouseleave="hoverable ? hideTooltip() : undefined"
      >
        <span :class="arrowClass" :style="arrowStyle"></span>
        {{ text }}
      </span>
    </Transition>
  </Teleport>
</template>
