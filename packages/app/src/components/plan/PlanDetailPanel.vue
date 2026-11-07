<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import type { DetailMode } from './detail-mode'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import Tooltip from '../ui/Tooltip.vue'
import PanelHeader from '../layout/PanelHeader.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 计划详情面板（右侧内容面板的计划内容类型，布局统一计划 §2.2/§4）：
 * 由看板内嵌深色抽屉迁出，头部沿用文件面板的头部规格，浅色视觉。
 * 草稿、编辑模式与冲突真值都在 plan store（卡片级编辑会话），本组件只展示与转发。
 *
 * 交互约定：
 * - 默认渲染 Markdown 预览，双击正文或点击「编辑」进入 textarea；预览/编辑两态。
 * - 分组按钮高亮读取 moveCard 同步后的 activeCard.status（与看板同源）。
 * - 删除进回收站，两步确认；保存与删除同在底部操作行。
 * - 正文撑满面板剩余高度并内部滚动；保存成功回预览由 store 的状态机负责。
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

/** 删除两步确认（随卡片切换清残留；草稿与视图态恢复由 store 负责） */
const isDeleteConfirmOpen = ref<string | null>(null)

watch(
  () => props.activeCard.id,
  () => {
    isDeleteConfirmOpen.value = null
  },
)

/** 正文展示值：有草稿显示草稿（预览可见未保存内容） */
const draftValue = computed(() => props.draftBody ?? props.activeCard.body)

/* ---------- 详情操作 ---------- */

function onDraftInput(event: Event) {
  emit('updateDraft', (event.target as HTMLTextAreaElement).value)
}

function onTitleInput(event: Event) {
  emit('updateDraftTitle', (event.target as HTMLInputElement).value)
}

function confirmDelete(id: string) {
  isDeleteConfirmOpen.value = id
}

function doDelete(id: string) {
  isDeleteConfirmOpen.value = null
  emit('removeCard', id)
}

function formatTime(iso: string): string {
  if (!iso) {
    return '未知时间'
  }
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="plan-detail">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <input
          type="text"
          class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
          placeholder="计划名"
          data-testid="plan-detail-title"
          :value="draftTitle ?? activeCard.title"
          @input="onTitleInput"
        >
      </template>
      <template #actions>
        <!-- 预览/编辑 两态分段控件（与文件面板头部控件同规格，无「原始」模式） -->
        <div class="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          <Tooltip
            v-for="mode in [
              { key: 'preview', label: '预览' },
              { key: 'edit', label: '编辑' },
            ]"
            :key="mode.key"
            :text="mode.label"
            :delay="300"
            preferred-placement="bottom"
          >
            <button
              :aria-label="`${mode.label}正文`"
              :class="[
                'flex items-center justify-center rounded-md p-1.5 transition-colors',
                detailMode === mode.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              ]"
              :data-testid="mode.key === 'edit' ? 'plan-detail-edit' : undefined"
              @click="emit('setDetailMode', mode.key as DetailMode)"
            >
              <!-- 预览（眼睛） -->
              <AppIcon v-if="mode.key === 'preview'" name="eye" :size="16" class="h-4 w-4" />
              <!-- 编辑（铅笔） -->
              <AppIcon name="square-pen" :size="16" class="h-4 w-4" v-else />
            </button>
          </Tooltip>
        </div>
      </template>
    </PanelHeader>

    <!-- 内容区：分组状态 + 正文（内部滚动）+ 底部操作行 -->
    <div class="flex min-h-0 flex-1 flex-col px-4">
      <!-- 五个分组状态（头部下方固定区，选中态与看板同源） -->
      <div class="flex shrink-0 flex-wrap gap-1.5 pb-2 pt-3">
        <button
          v-for="(label, value) in PLAN_COLUMN_LABELS"
          :key="value"
          :class="[
            'rounded-md px-2 py-1 text-xs transition-colors',
            activeCard.status === value
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
          ]"
          @click="emit('moveCard', activeCard.id, value as PlanStatusView, null)"
        >
          {{ label }}
        </button>
      </div>

      <!-- 外部修改提醒：用户选择重新读取或保留草稿 -->
      <div v-if="conflictNotice" class="shrink-0 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
        <p>这个计划文件已被外部修改（AI 或编辑器）。当前草稿不会覆盖它。</p>
        <div class="mt-2 flex gap-2">
          <button class="rounded bg-amber-100 px-2 py-1 text-amber-800 hover:bg-amber-200" @click="emit('reloadFromConflict')">
            重新读取
          </button>
          <button class="rounded bg-gray-100 px-2 py-1 text-gray-600 hover:bg-gray-200" @click="emit('keepDraft')">
            保留草稿继续编辑
          </button>
        </div>
      </div>

      <!-- 预览态：渲染 Markdown（显示当前草稿），双击进入编辑 -->
      <div
        v-if="detailMode === 'preview'"
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

      <p v-if="actionError" class="shrink-0 pt-1 text-xs text-red-600">{{ actionError }}</p>

      <!-- 底部操作行：保存 + 未保存标记 + 更新时间 + 删除（同一行，宽度不足换行） -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 py-3">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="!hasUnsavedChanges || isSaving"
          data-testid="plan-detail-save"
          @click="emit('saveDraft')"
        >
          {{ isSaving ? '保存中…' : '保存' }}
        </button>
        <span v-if="hasUnsavedChanges" class="flex items-center gap-1 text-xs text-amber-600">
          <span class="h-1.5 w-1.5 rounded-full bg-amber-500" />
          未保存
        </span>
        <span v-if="activeCard.updatedAt" class="text-[10px] text-gray-400">
          更新于 {{ formatTime(activeCard.updatedAt) }}
        </span>

        <span class="ml-auto">
          <button
            v-if="isDeleteConfirmOpen !== activeCard.id"
            class="rounded-lg border border-gray-200 bg-white px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
            @click="confirmDelete(activeCard.id)"
          >
            删除（移入回收站）
          </button>
          <span v-else class="flex items-center gap-1.5 text-xs text-gray-500">
            <span>移入回收站？</span>
            <button class="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-500" @click="doDelete(activeCard.id)">删除</button>
            <button class="rounded bg-gray-100 px-2 py-1 text-gray-600 hover:bg-gray-200" @click="isDeleteConfirmOpen = null">取消</button>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
