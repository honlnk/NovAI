<script setup lang="ts">
import { computed } from 'vue'

/**
 * 普通正文表面（六个模块右侧详情布局统一计划 阶段 1）：单正文预览／编辑的
 * 统一容器规格——边框、背景、内边距、滚动边界的唯一实现。正文内容、草稿
 * 与输入状态由插槽方（领域）持有，本组件不接管。
 *
 * - preview：预览态阅读表面（浅灰底、四边留白、内部滚动）；
 * - edit：编辑态外框（白底、窄边距；textarea 自身滚动）；
 * - warning：伏笔作者真相等警示正文（琥珀边框与底色）。
 */
const props = withDefaults(
  defineProps<{
    variant?: 'preview' | 'edit'
    /** 警示正文（作者真相 / 剧透区） */
    tone?: 'plain' | 'warning'
    /** 预览态默认内部滚动；编辑态外框不滚动（textarea 自己滚） */
    scroll?: boolean
  }>(),
  { variant: 'preview', tone: 'plain', scroll: undefined },
)

const surfaceClass = computed(() => {
  const warning = props.tone === 'warning'
  const scroll = props.scroll ?? props.variant === 'preview'
  return [
    'flex min-h-0 flex-1 flex-col rounded-lg border',
    props.variant === 'preview'
      ? warning ? 'border-amber-200 bg-amber-50 p-4' : 'border-gray-200 bg-gray-50 p-4'
      : warning ? 'border-amber-200 bg-white p-2' : 'border-gray-200 bg-white p-2',
    scroll ? 'overflow-y-auto' : '',
  ]
})
</script>

<template>
  <div :class="surfaceClass" data-testid="detail-body-surface">
    <slot />
  </div>
</template>
