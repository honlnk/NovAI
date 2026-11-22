<script setup lang="ts">
import { computed, type Component } from 'vue'

import { APP_ICONS, type AppIconName } from './app-icons'

/**
 * 受控语义图标组件：按名称渲染 app-icons.ts 中显式注册的 Lucide 线性图形。
 * 图形不在这里新增——需要新图标时先去 app-icons.ts 登记再使用。
 */
const props = defineProps<{
  name: AppIconName
  /** 渲染边长（px），与现有手绘图标的常用尺寸保持一致 */
  size?: number
}>()

const iconComponent = computed<Component>(() => APP_ICONS[props.name])
</script>

<template>
  <component
    :is="iconComponent"
    class="shrink-0"
    :size="size ?? 16"
    aria-hidden="true"
  />
</template>
