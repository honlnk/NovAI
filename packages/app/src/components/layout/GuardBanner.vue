<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'

/**
 * 守护横幅（六个模块右侧详情布局统一计划 阶段 1）：删除／重命名守护的统一
 * 展示结构——琥珀警示横幅、标题、说明、路径行、出口按钮区与副本表单区。
 * 文案、出口按钮与表单字段由领域通过插槽注入（文件恢复为路径副本、卡片恢复
 * 为新卡片），本组件不判断领域，不执行任何守护业务。
 */
defineProps<{
  /** 守护类别：deleted（含回收站去向行）/ renamed（含新位置行） */
  kind: 'deleted' | 'renamed'
  /** 标题（如「某某」已被 AI 删除并移入回收站） */
  title: string
  /** 说明（保留内容与出口语义） */
  description: string
  /** 路径行（回收站去向 / 重命名新位置；空值不渲染） */
  detail?: { label: string; value: string } | null
}>()
</script>

<template>
  <div
    class="mb-3 flex shrink-0 flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5"
    role="alert"
    data-testid="detail-guard-banner"
  >
    <div class="flex items-start gap-2">
      <AppIcon name="triangle-alert" :size="15" class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
        <p class="font-medium">{{ title }}</p>
        <p class="text-amber-700">{{ description }}</p>
        <p v-if="detail" class="truncate text-[11px] text-amber-600" :title="detail.value">
          {{ detail.label }}：{{ detail.value }}
        </p>
      </div>
    </div>
    <!-- 出口按钮组：领域注入（恢复副本 / 放弃 / 迁移等） -->
    <div class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
    <!-- 副本表单区：领域注入（文件路径表单 / 卡片名称表单），开合由领域持有 -->
    <slot name="form" />
  </div>
</template>
