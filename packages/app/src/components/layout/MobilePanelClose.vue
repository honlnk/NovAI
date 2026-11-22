<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'

/**
 * 分类侧栏移动端关闭按钮：由 CategoryPanel 经各列表的 mobile-close 插槽
 * 注入标题行右端（如「+ 新对话」/刷新按钮旁），与标题行同行排布、不占独立
 * 空间；仅移动端渲染（lg:hidden），桌面标题行保持原样。
 */
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <button
    aria-label="关闭分类面板"
    class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
    @click="emit('close')"
  >
    <AppIcon name="x" :size="16" class="h-4 w-4" />
  </button>
</template>
