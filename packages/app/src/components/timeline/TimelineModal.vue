<script setup lang="ts">
/**
 * 时间轴弹窗（时间线 JSON 化改造施工计划 §9.4）：组合 WorkspaceModal 外壳。
 *
 * 阶段 1 为空壳——只承载入口与标题；时间轴 SVG 渲染、详情编辑与保存会话在
 * 阶段 3 接入（届时经 timeline-service 载入事件账本，这里只消费视图数据）。
 */
import WorkspaceModal from '../layout/WorkspaceModal.vue'

defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <WorkspaceModal
    :is-open="true"
    title="时间轴"
    subtitle="事件账本 · 按故事内顺序排列"
    empty
    empty-text="时间轴建设中：事件账本的时间轴视图将在本计划阶段 3 上线；当前可通过 AI 工具维护事件。"
    @close="emit('close')"
  />
</template>
