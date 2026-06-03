<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  close: []
  goToSettings: []
}>()

const isVisible = ref(true)

function handleClose() {
  isVisible.value = false
  emit('close')
}

function handleGoToSettings() {
  isVisible.value = false
  emit('goToSettings')
}
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-300 ease-out"
    enter-from-class="opacity-0 scale-95"
    enter-to-class="opacity-100 scale-100"
    leave-active-class="transition-all duration-200 ease-in"
    leave-from-class="opacity-100 scale-100"
    leave-to-class="opacity-0 scale-95"
  >
    <div
      v-if="isVisible"
      class="rounded-lg border border-blue-200 bg-blue-50 p-6"
    >
      <div class="flex items-start gap-4">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100">
          <svg class="h-5 w-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="mb-2 text-lg font-semibold text-blue-900">欢迎使用 NovAI！</h3>
          <p class="mb-4 text-sm text-blue-700">
            在开始创作之前，建议先完成以下设置：
          </p>
          <div class="space-y-3">
            <div class="flex items-center gap-3">
              <div class="flex h-6 w-6 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold text-blue-800">
                1
              </div>
              <span class="text-sm text-blue-800">配置 LLM API（用于 AI 生成）</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="flex h-6 w-6 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold text-blue-800">
                2
              </div>
              <span class="text-sm text-blue-800">配置 Embedding API（用于 RAG 检索，可选）</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="flex h-6 w-6 items-center justify-center rounded-full bg-blue-200 text-xs font-semibold text-blue-800">
                3
              </div>
              <span class="text-sm text-blue-800">设置系统提示词（指导 AI 创作风格）</span>
            </div>
          </div>
          <div class="mt-4 flex gap-3">
            <button
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              @click="handleGoToSettings"
            >
              去配置
            </button>
            <button
              class="rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100"
              @click="handleClose"
            >
              稍后再说
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
