<script setup lang="ts">
/**
 * iOS 风格开关（样式照抄 gpt-image-studio 的自绘 switch）。
 */
const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function toggle() {
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    class="relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors"
    :class="modelValue ? 'bg-gray-900' : 'bg-gray-300'"
    @click="toggle"
  >
    <span
      class="inline-block h-4 w-4 rounded-full bg-white transition-transform"
      :class="modelValue ? 'translate-x-4' : 'translate-x-0.5'"
    />
  </button>
</template>
