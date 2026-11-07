<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * 带「显示/隐藏」切换的密码输入框。
 * 右侧眼睛图标点击切换明文/密文，沿用 v-model 语义。
 */
defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isVisible = ref(false)

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="relative">
    <input
      :type="isVisible ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholder"
      class="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm outline-none focus:border-gray-500"
      @input="onInput"
    />
    <button
      type="button"
      :title="isVisible ? '隐藏' : '显示'"
      class="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-gray-400 transition-colors hover:text-gray-600"
      @click="isVisible = !isVisible"
    >
      <!-- 眼睛（显示状态） -->
      <AppIcon v-if="isVisible" name="eye" :size="20" class="h-5 w-5" />
      <!-- 划线眼睛（隐藏状态） -->
      <AppIcon name="eye-off" :size="20" class="h-5 w-5" v-else />
    </button>
  </div>
</template>
