<script setup lang="ts">
/**
 * 卡片状态工具（六个模块右侧详情布局统一计划 阶段 1，卡片展示适配器组成件）：
 * 三类卡片详情共用的分组列按钮——选中态读取已生效列 key（保存成功才切换），
 * 待保存状态用中性底与点状等待标记（不伪装成已生效），点击只登记待保存状态。
 * 空列（节奏卡不提供手改状态）不渲染容器、不占位。
 */
defineProps<{
  /** 领域列按钮（顺序即展示顺序） */
  columns: ReadonlyArray<{ key: string; label: string }>
  /** 当前已生效列 key */
  activeColumnKey: string
  /** 待保存状态列 key（等待标记；null = 无状态修改） */
  pendingColumnKey: string | null
}>()

const emit = defineEmits<{
  /** 状态按钮点击：登记待保存状态（领域 store 的 updateDraftStatus） */
  select: [columnKey: string]
}>()

defineOptions({ inheritAttrs: false })
</script>

<template>
  <div v-if="columns.length > 0" class="flex shrink-0 flex-wrap gap-1.5" data-testid="card-status-tools">
    <button
      v-for="column in columns"
      :key="column.key"
      :class="[
        'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
        activeColumnKey === column.key
          ? 'bg-gray-900 text-white'
          : pendingColumnKey === column.key && column.key !== activeColumnKey
            ? 'bg-gray-200 text-gray-700'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
      ]"
      :title="pendingColumnKey === column.key && column.key !== activeColumnKey ? '两秒后随本卡片一起保存' : undefined"
      @click="emit('select', column.key)"
    >
      <span
        v-if="pendingColumnKey === column.key && column.key !== activeColumnKey"
        class="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500"
      />
      {{ column.label }}
    </button>
  </div>
</template>
