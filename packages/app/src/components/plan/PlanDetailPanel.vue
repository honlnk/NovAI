<script setup lang="ts">
import { computed, toRef } from 'vue'

import type { PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import { useTransientEdit } from '../../composables/useTransientEdit'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import CardConflictBar from '../card-board/CardConflictBar.vue'
import CardConflictResolution from '../card-board/CardConflictResolution.vue'
import CardGuardNotice from '../card-board/CardGuardNotice.vue'
import CardSaveFailure from '../card-board/CardSaveFailure.vue'
import CardStatusTools from '../card-board/CardStatusTools.vue'
import type { DetailMode } from '../layout/detail-mode'
import DetailLayout from '../layout/DetailLayout.vue'
import PlainBodySurface from '../layout/PlainBodySurface.vue'

/**
 * 计划详情面板：统一详情布局（components/layout/DetailLayout.vue）的计划领域
 * 装配——正文区是 Markdown 预览 / textarea 编辑两态（统一正文表面）。草稿、
 * 编辑模式与冲突真值都在 plan store（卡片级编辑会话），本组件只展示与转发。
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
  /** 待保存的普通状态（状态按钮等待标记）；null = 无状态修改 */
  draftStatus: PlanStatusView | null
  /** 详情视图态（预览/编辑，随卡片编辑会话恢复） */
  detailMode: DetailMode
  savePhase: 'clean' | 'pending' | 'saving' | 'failed' | 'conflict'
  /** 冲突视图（阶段 3：紧凑条与展开比较驱动） */
  conflict: { probing: boolean; missing: boolean; unreadable?: string; expanded: boolean } | null
  /** 冲突字段比较（store 按领域字段组合好的 mine/disk 文本） */
  conflictFields: ReadonlyArray<CardConflictField>
  /** 守护信息（删除/重命名；null = 无守护） */
  guard: CardSessionGuard | null
  /** 副本创建进行中（冲突比较「另存为新卡片」与守护「恢复为新卡片」共用） */
  conflictCopyBusy: boolean
  /** 副本创建失败原因（受控回灌：失败保留表单与名称） */
  conflictCopyError: string
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateDraft: [body: string]
  updateDraftTitle: [title: string]
  updateDraftStatus: [status: PlanStatusView]
  setDetailMode: [mode: DetailMode]
  retrySave: []
  expandConflict: []
  collapseConflict: []
  adoptDisk: []
  adoptMine: []
  saveCopy: [name: string]
  restoreAsCopy: [name: string]
  discardGuard: []
}>()

/** 分组列按钮：常驻四列 + 已搁置（与看板展示口径解耦，详情里始终全量可切） */
const columnButtons = computed(() =>
  (Object.entries(PLAN_COLUMN_LABELS) as [PlanStatusView, string][])
    .map(([status, label]) => ({ key: status, label })),
)

/** 头部名称输入展示值（草稿优先） */
const titleValue = computed(() => props.draftTitle ?? props.activeCard.title)

/** 正文展示值：有草稿显示草稿（预览可见未保存内容） */
const draftValue = computed(() => props.draftBody ?? props.activeCard.body)

/* ---------- 临时编辑（双击快改即走）：静置无改动亮「等待保存」并同窗收口回预览，有改动自动保存完成回预览 ---------- */
const { markTransient, displaySavePhase } = useTransientEdit({
  savePhase: toRef(props, 'savePhase'),
  detailMode: toRef(props, 'detailMode'),
  onReturnToPreview: () => emit('setDetailMode', 'preview'),
})
/** 预览态双击正文进入临时编辑；点「编辑」按钮进入的常规编辑不受影响 */
function onBodyDblClick() {
  if (props.guard) return
  markTransient()
  emit('setDetailMode', 'edit')
}

function onDraftInput(event: Event) {
  emit('updateDraft', (event.target as HTMLTextAreaElement).value)
}

function onTitleInput(event: Event) {
  emit('updateDraftTitle', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <DetailLayout
    :mode="detailMode"
    :has-content="true"
    :save-phase="displaySavePhase"
    :path="activeCard.sourcePath"
    :updated-at="activeCard.updatedAt"
    noun="正文"
    save-testid="plan-detail-save-status"
    :conflict-expanded="conflict?.expanded === true"
    @close="emit('close')"
    @mode-change="emit('setDetailMode', $event)"
  >
    <template #title>
      <input
        type="text"
        class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
        placeholder="计划名"
        data-testid="plan-detail-title"
        :value="titleValue"
        :readonly="guard !== null"
        @input="onTitleInput"
      >
    </template>

    <!-- 消息区：守护横幅 / 冲突紧凑条 / 保存失败（重试在消息区） -->
    <template #message>
      <CardGuardNotice
        v-if="guard"
        :guard="guard"
        :title-value="titleValue"
        :restore-busy="conflictCopyBusy"
        :restore-error="conflictCopyError"
        @restore-as-copy="(name) => emit('restoreAsCopy', name)"
        @discard-guard="emit('discardGuard')"
      />
      <CardConflictBar
        v-if="conflict && !conflict.expanded"
        testid-prefix="plan"
        @expand="emit('expandConflict')"
      />
      <CardSaveFailure
        v-if="savePhase === 'failed'"
        testid-prefix="plan"
        :message="actionError"
        @retry="emit('retrySave')"
      />
      <p v-else-if="actionError" class="mb-3 shrink-0 text-xs text-red-600">{{ actionError }}</p>
    </template>

    <!-- 工具区：状态列按钮（守护时冻结，不给误导性的状态出口） -->
    <template #tools>
      <CardStatusTools
        v-if="!guard"
        :columns="columnButtons"
        :active-column-key="activeCard.status"
        :pending-column-key="draftStatus"
        @select="(columnKey) => emit('updateDraftStatus', columnKey as PlanStatusView)"
      />
    </template>

    <!-- 主内容：单正文预览/编辑（统一正文表面） -->
    <template #content>
      <!-- 预览态：纯文本渲染（显示当前草稿），双击进入编辑。正文是 textarea 自由文本，
           不走 markdown（单换行折叠与意外标记变形，见节奏意图同款修复） -->
      <PlainBodySurface
        v-if="detailMode === 'preview'"
        variant="preview"
        data-testid="plan-detail-preview"
        @dblclick="onBodyDblClick"
      >
        <div
          v-if="draftValue"
          class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
        >{{ draftValue }}</div>
        <p v-else class="text-sm text-gray-400">双击或点击「编辑」开始书写正文。</p>
      </PlainBodySurface>

      <!-- 编辑态：多行文本框（不做实时渲染）；守护期间冻结输入（写入已被拒绝） -->
      <PlainBodySurface v-else variant="edit">
        <textarea
          :value="draftBody ?? activeCard.body"
          :readonly="guard !== null"
          class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="自由记录正文（纯文本，回车即换行）。"
          data-testid="plan-detail-body"
          @input="onDraftInput"
        />
      </PlainBodySurface>
    </template>

    <!-- 冲突展开：卡片冲突处理装配（说明/字段比较/副本文案/四出口） -->
    <template #conflict>
      <CardConflictResolution
        :card-id="activeCard.id"
        :title-value="titleValue"
        :conflict="conflict!"
        :conflict-fields="conflictFields"
        :copy-busy="conflictCopyBusy"
        :copy-error="conflictCopyError"
        @collapse="emit('collapseConflict')"
        @adopt-disk="emit('adoptDisk')"
        @adopt-mine="emit('adoptMine')"
        @save-copy="(name) => emit('saveCopy', name)"
      />
    </template>
  </DetailLayout>
</template>
