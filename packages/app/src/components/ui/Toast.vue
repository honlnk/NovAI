<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ToastAction } from '../../composables/useToast'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  /** 自动关闭时长（毫秒），缺省 3000；null = 持续显示（错误提示，数据安全计划 F11），由用户手动关闭 */
  duration?: number | null
  /** 内联动作按钮（撤销 / 查看已归档等）；缺省不渲染按钮 */
  actions?: ToastAction[]
}>()

const emit = defineEmits<{
  close: []
}>()

const isVisible = ref(true)

function dismiss() {
  isVisible.value = false
  setTimeout(() => emit('close'), 200)
}

function runAction(action: ToastAction) {
  action.run()
  dismiss()
}

onMounted(() => {
  // null = 持续显示（错误提示）：不安排自动关闭，唯一出口是用户点击关闭
  if (props.duration === null) return
  const duration = props.duration ?? 3000
  setTimeout(dismiss, duration)
})
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-300 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition-all duration-200 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div
      v-if="isVisible"
      :class="[
        'flex items-center gap-3 rounded-lg px-4 py-3 shadow-lg',
        type === 'success' ? 'bg-green-600 text-white' : '',
        type === 'error' ? 'bg-red-600 text-white' : '',
        // 黄色提醒走低饱和浅底细边框（交互优化计划 §5），不用整块染黄
        type === 'warning' ? 'border border-amber-200 bg-amber-50 text-amber-800' : '',
        type === 'info' || !type ? 'bg-gray-800 text-white' : '',
      ]"
    >
      <!-- 图标 -->
      <AppIcon name="circle-check" :size="20" class="h-5 w-5 shrink-0" v-if="type === 'success'" />
      <AppIcon name="circle-alert" :size="20" class="h-5 w-5 shrink-0" v-else-if="type === 'error'" />
      <AppIcon name="triangle-alert" :size="20" class="h-5 w-5 shrink-0" v-else-if="type === 'warning'" />
      <AppIcon name="info" :size="20" class="h-5 w-5 shrink-0" v-else />

      <!-- 消息 -->
      <span class="text-sm">{{ message }}</span>

      <!-- 动作按钮（撤销 / 查看已归档等） -->
      <button
        v-for="action in actions"
        :key="action.label"
        class="shrink-0 rounded px-1.5 py-0.5 text-sm font-medium underline underline-offset-2 transition-colors hover:bg-white/20"
        @click="runAction(action)"
      >
        {{ action.label }}
      </button>

      <!-- 关闭按钮 -->
      <button
        aria-label="关闭提示"
        class="ml-2 shrink-0 rounded p-1 transition-colors hover:bg-white/20"
        @click="dismiss()"
      >
        <AppIcon name="x" :size="16" class="h-4 w-4" />
      </button>
    </div>
  </Transition>
</template>
