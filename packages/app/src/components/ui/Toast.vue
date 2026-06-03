<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{
  message: string
  type?: 'success' | 'error' | 'info'
  duration?: number
}>()

const emit = defineEmits<{
  close: []
}>()

const isVisible = ref(true)

onMounted(() => {
  const duration = props.duration ?? 3000
  setTimeout(() => {
    isVisible.value = false
    setTimeout(() => emit('close'), 300)
  }, duration)
})
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-300 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition-all duration-300 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div
      v-if="isVisible"
      :class="[
        'fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg px-4 py-3 shadow-lg',
        type === 'success' ? 'bg-green-600 text-white' : '',
        type === 'error' ? 'bg-red-600 text-white' : '',
        type === 'info' || !type ? 'bg-gray-800 text-white' : '',
      ]"
    >
      <!-- 图标 -->
      <svg
        v-if="type === 'success'"
        class="h-5 w-5 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <svg
        v-else-if="type === 'error'"
        class="h-5 w-5 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <svg
        v-else
        class="h-5 w-5 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>

      <!-- 消息 -->
      <span class="text-sm">{{ message }}</span>

      <!-- 关闭按钮 -->
      <button
        class="ml-2 shrink-0 rounded p-1 transition-colors hover:bg-white/20"
        @click="emit('close')"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </Transition>
</template>
