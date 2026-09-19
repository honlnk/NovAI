<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import type { PermissionPreset } from '@novai/core/types/project'

import { PERMISSION_PRESET_OPTIONS, permissionPresetLabel } from '../../constants/permission-presets'

/**
 * 写工具权限档位选择器（对话输入区入口，权限文档 1.6）：
 * 按钮显示当前档位名，点击在按钮上方弹出五档菜单（dsh popover 形态），当前档带勾。
 * 选中后 emit，由 ChatPanel 走与设置页相同的 updateConfig 写回链路。
 */
const props = defineProps<{
  preset: PermissionPreset
}>()

const emit = defineEmits<{
  (e: 'select', preset: PermissionPreset): void
}>()

const isOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

function toggle() {
  isOpen.value = !isOpen.value
}

function select(preset: PermissionPreset) {
  isOpen.value = false
  if (preset !== props.preset) {
    emit('select', preset)
  }
}

/** 点击组件外部 / Esc 关闭弹层 */
function handlePointerDown(event: PointerEvent) {
  if (isOpen.value && rootRef.value && !rootRef.value.contains(event.target as Node)) {
    isOpen.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
      :title="`写工具权限：${permissionPresetLabel(preset)}（点击切换档位）`"
      @click="toggle"
    >
      <svg class="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
      <span>{{ permissionPresetLabel(preset) }}</span>
      <svg
        class="h-3 w-3 text-gray-400 transition-transform"
        :class="isOpen ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- 五档菜单：按钮上方弹出 -->
    <div
      v-if="isOpen"
      class="absolute bottom-full left-0 z-20 mb-1.5 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
      role="menu"
      aria-label="写工具权限档位"
    >
      <button
        v-for="option in PERMISSION_PRESET_OPTIONS"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :aria-checked="option.value === preset"
        class="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50"
        @click="select(option.value)"
      >
        <svg
          class="mt-0.5 h-4 w-4 shrink-0"
          :class="option.value === preset ? 'text-blue-600' : 'text-transparent'"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-gray-800">{{ option.label }}</span>
          <span class="mt-0.5 block text-xs leading-snug text-gray-500">{{ option.hint }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
