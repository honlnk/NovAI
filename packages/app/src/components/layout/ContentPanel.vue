<script setup lang="ts">
import { ref } from 'vue'
import ResizeHandle from './ResizeHandle.vue'

/**
 * 右侧内容面板外壳（布局统一计划 §2.1）：宽度、边框、收起、遮罩、移动端抽屉
 * 与底部状态栏避让在此统一承载；具体内容（普通文件 / 计划详情 / 新建计划）
 * 由 ProjectView 按分类与当前任务通过默认槽位填充。
 */
const props = defineProps<{
  isOpen: boolean
  /** 内容面板宽度（px），由 ProjectView 持有并持久化（R7） */
  width: number
}>()

const emit = defineEmits<{
  /** 遮罩点击 / 内容头部关闭按钮的统一关闭入口（按当前内容类型收敛对应偏好） */
  close: []
  /** 拖拽改宽：发出 clamp 后的目标宽度（R7） */
  resize: [width: number]
  /** 双击手柄重置到默认宽度（R7） */
  'reset-width': []
}>()

/** 拖拽改宽进行中（R7）：暂停 aside 过渡动画，避免宽度变化滞后于光标 */
const isResizing = ref(false)

function handleResize(width: number) {
  emit('resize', Math.max(240, Math.min(720, width)))
}
</script>

<template>
  <!-- 移动端遮罩 -->
  <div
    v-if="isOpen"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden"
    @click="emit('close')"
  />

  <!-- 内容面板（桌面实际占位可收起，窄屏右侧抽屉；bottom-7 让开底部状态栏） -->
  <aside
    :class="[
      'relative flex shrink-0 flex-col border-l border-gray-200 bg-white',
      isResizing ? '' : 'transition-all duration-200',
      'max-lg:fixed max-lg:top-0 max-lg:bottom-7 max-lg:right-0 max-lg:z-50 max-lg:max-w-full',
      isOpen ? '' : 'w-0 overflow-hidden',
      isOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full',
    ]"
    :style="isOpen ? { width: width + 'px' } : undefined"
  >
    <!-- 拖拽改宽手柄（仅 lg: 以上显示，R7） -->
    <ResizeHandle
      :start-width="width"
      @dragstart="isResizing = true"
      @drag="handleResize"
      @dragend="isResizing = false"
      @reset="emit('reset-width')"
    />

    <slot />
  </aside>
</template>
