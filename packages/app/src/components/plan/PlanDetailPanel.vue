<script setup lang="ts">
import { computed } from 'vue'

import type { PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import type { DetailMode } from './detail-mode'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import DetailPanel from '../card-board/DetailPanel.vue'

/**
 * 计划详情面板：通用详情骨架（components/card-board/DetailPanel.vue）的计划领域
 * 装配——正文区是 Markdown 预览 / textarea 编辑两态。草稿、编辑模式与冲突真值
 * 都在 plan store（卡片级编辑会话），本组件只展示与转发。
 */
const props = defineProps<{
  /** 详情面板（含草稿/冲突态真值在 store） */
  activeCard: {
    id: string
    title: string
    status: PlanStatusView
    body: string
    updatedAt: string
    sourcePath: string
  }
  draftBody: string | null
  /** 计划名草稿（详情头部输入框） */
  draftTitle: string | null
  /** 详情视图态（预览/编辑，随卡片编辑会话恢复） */
  detailMode: DetailMode
  isSaving: boolean
  conflictNotice: { currentCard: { body: string } } | null
  actionError: string
  hasUnsavedChanges: boolean
}>()

const emit = defineEmits<{
  close: []
  updateDraft: [body: string]
  updateDraftTitle: [title: string]
  setDetailMode: [mode: DetailMode]
  saveDraft: []
  reloadFromConflict: []
  keepDraft: []
  moveCard: [id: string, status: PlanStatusView, afterId: string | null]
  removeCard: [id: string]
}>()

/** 分组列按钮：常驻四列 + 已搁置（与看板展示口径解耦，详情里始终全量可切） */
const columnButtons = computed(() =>
  (Object.entries(PLAN_COLUMN_LABELS) as [PlanStatusView, string][])
    .map(([status, label]) => ({ key: status, label })),
)

/** 正文展示值：有草稿显示草稿（预览可见未保存内容） */
const draftValue = computed(() => props.draftBody ?? props.activeCard.body)

function onDraftInput(event: Event) {
  emit('updateDraft', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <DetailPanel
    :card-id="activeCard.id"
    :title-value="draftTitle ?? activeCard.title"
    title-placeholder="计划名"
    :columns="columnButtons"
    :active-column-key="activeCard.status"
    :detail-mode="detailMode"
    :is-saving="isSaving"
    :has-conflict="conflictNotice !== null"
    :action-error="actionError"
    :has-unsaved-changes="hasUnsavedChanges"
    :updated-at="activeCard.updatedAt"
    delete-label="删除（移入回收站）"
    testid-prefix="plan"
    @close="emit('close')"
    @update-title="emit('updateDraftTitle', $event)"
    @set-detail-mode="emit('setDetailMode', $event)"
    @save-draft="emit('saveDraft')"
    @reload-from-conflict="emit('reloadFromConflict')"
    @keep-draft="emit('keepDraft')"
    @move-card="(columnKey) => emit('moveCard', activeCard.id, columnKey as PlanStatusView, null)"
    @remove-card="emit('removeCard', activeCard.id)"
  >
    <template #content="{ detailMode: mode }">
      <!-- 预览态：渲染 Markdown（显示当前草稿），双击进入编辑 -->
      <div
        v-if="mode === 'preview'"
        class="mt-2 min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
        data-testid="plan-detail-preview"
        @dblclick="emit('setDetailMode', 'edit')"
      >
        <MarkdownRenderer v-if="draftValue" :content="draftValue" />
        <p v-else class="text-sm text-gray-400">双击或点击「编辑」开始书写正文。</p>
      </div>

      <!-- 编辑态：多行文本框（不做实时渲染） -->
      <textarea
        v-else
        :value="draftBody ?? activeCard.body"
        class="mt-2 min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder="自由记录正文；支持 Markdown。"
        data-testid="plan-detail-body"
        @input="onDraftInput"
      />
    </template>
  </DetailPanel>
</template>
