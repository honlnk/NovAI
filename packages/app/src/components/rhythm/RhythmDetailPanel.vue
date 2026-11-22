<script setup lang="ts">
import { computed, toRef } from 'vue'

import type { RhythmCardView } from '@novai/core/services/types'
import { RHYTHM_COLUMN_LABELS, RHYTHM_HOOKS, RHYTHM_MOODS, RHYTHM_MOOD_DESCRIPTIONS, RHYTHM_PAYOFFS } from '@novai/core/types/rhythm'
import { useTransientEdit } from '../../composables/useTransientEdit'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import CardConflictBar from '../card-board/CardConflictBar.vue'
import CardConflictResolution from '../card-board/CardConflictResolution.vue'
import CardGuardNotice from '../card-board/CardGuardNotice.vue'
import CardSaveFailure from '../card-board/CardSaveFailure.vue'
import type { DetailMode } from '../layout/detail-mode'
import DetailLayout from '../layout/DetailLayout.vue'
import PlainBodySurface from '../layout/PlainBodySurface.vue'

/**
 * 节奏详情面板（§七）：统一详情布局（components/layout/DetailLayout.vue）的节奏
 * 领域装配——计划值编辑区（冲突强度滑块、情绪/钩子/爽点下拉、出场角色多选
 * 输入、节奏意图文本）+ 实际值展示区（只读——回写走 AI 写后同步或直接编文件，
 * UI 不提供手改 actual_*）+ 偏差说明。状态徽标只读展示：状态与偏差由系统按
 * 回写偏差自动判定，面板不提供状态工具（无工具区插槽）。
 */
const props = defineProps<{
  activeCard: RhythmCardView
  draftName: string | null
  draftPlannedConflict: number | null
  draftPlannedMood: string | null
  draftPlannedHook: string | null
  draftPlannedPayoff: string | null
  draftPlannedCharacters: string | null
  draftPlannedNote: string | null
  draftIntentBody: string | null
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
  updateDraft: [partial: {
    name?: string
    plannedConflict?: number
    plannedMood?: string
    plannedHook?: string
    plannedPayoff?: string
    plannedCharacters?: string
    plannedNote?: string
    intentBody?: string
  }]
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

/** 头部名称输入展示值（草稿优先） */
const titleValue = computed(() => props.draftName ?? props.activeCard.name)

/* ---------- 临时编辑（双击快改即走）：静置无改动亮「等待保存」并同窗收口回预览，有改动自动保存完成回预览 ---------- */
const { markTransient, displaySavePhase } = useTransientEdit({
  savePhase: toRef(props, 'savePhase'),
  detailMode: toRef(props, 'detailMode'),
  onReturnToPreview: () => emit('setDetailMode', 'preview'),
})
/** 预览态双击正文进入临时编辑；点「编辑」按钮进入的常规编辑不受影响 */
function onIntentDblClick() {
  if (props.guard) return
  markTransient()
  emit('setDetailMode', 'edit')
}

/* ---------- 展示值：有草稿显示草稿（预览态也跟随未保存修改） ---------- */

const plannedConflictValue = computed(() => props.draftPlannedConflict ?? props.activeCard.plannedConflict)
const plannedMoodValue = computed(() => props.draftPlannedMood ?? props.activeCard.plannedMood)
const plannedHookValue = computed(() => props.draftPlannedHook ?? props.activeCard.plannedHook)
const plannedPayoffValue = computed(() => props.draftPlannedPayoff ?? props.activeCard.plannedPayoff)
const plannedCharactersValue = computed(() => props.draftPlannedCharacters ?? props.activeCard.plannedCharacters.join('、'))
const plannedNoteValue = computed(() => props.draftPlannedNote ?? (props.activeCard.plannedNote ?? ''))
const intentBodyValue = computed(() => props.draftIntentBody ?? props.activeCard.intentBody)

const isWritten = computed(() => props.activeCard.status !== 'planned')

/** 计划↔实际逐项对比（已回写时展示） */
const actualRows = computed(() => {
  const card = props.activeCard
  if (card.actualConflict === null) {
    return []
  }
  return [
    { label: '冲突强度', planned: String(card.plannedConflict), actual: String(card.actualConflict) },
    { label: '情绪基调', planned: card.plannedMood, actual: card.actualMood ?? '—' },
    { label: '章末钩子', planned: card.plannedHook, actual: card.actualHook ?? '—' },
    { label: '爽点类型', planned: card.plannedPayoff, actual: card.actualPayoff ?? '—' },
  ]
})

function onTitleInput(event: Event) {
  emit('updateDraft', { name: (event.target as HTMLInputElement).value })
}

function onIntentInput(event: Event) {
  emit('updateDraft', { intentBody: (event.target as HTMLTextAreaElement).value })
}

function onNoteInput(event: Event) {
  emit('updateDraft', { plannedNote: (event.target as HTMLInputElement).value })
}

function onCharactersInput(event: Event) {
  emit('updateDraft', { plannedCharacters: (event.target as HTMLInputElement).value })
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
    save-testid="rhythm-detail-save-status"
    :conflict-expanded="conflict?.expanded === true"
    @close="emit('close')"
    @mode-change="emit('setDetailMode', $event)"
  >
    <template #title>
      <input
        type="text"
        class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
        placeholder="节奏卡名"
        data-testid="rhythm-detail-title"
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
        testid-prefix="rhythm"
        @expand="emit('expandConflict')"
      />
      <CardSaveFailure
        v-if="savePhase === 'failed'"
        testid-prefix="rhythm"
        :message="actionError"
        @retry="emit('retrySave')"
      />
      <p v-else-if="actionError" class="mb-3 shrink-0 text-xs text-red-600">{{ actionError }}</p>
    </template>

    <!-- 主内容：状态徽标 + 计划值控件 + 实际值只读对比 + 节奏意图正文（无状态工具区）。
         短高度下整列纵向滚动（本区是滚动责任方；正文表面富余时自身滚动），
         DetailLayout 固定底部路径/时间不参与滚动 -->
    <template #content>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="rhythm-detail-scroll">
      <!-- 状态徽标（只读：状态由回写偏差判定自动流转，不接受手改） -->
      <div class="mb-2 flex shrink-0 items-center gap-2">
        <span
          :class="[
            'rounded-md px-2 py-1 text-xs font-medium',
            activeCard.status === 'deviated' ? 'bg-red-100 text-red-700'
              : activeCard.status === 'written' ? 'bg-emerald-100 text-emerald-700'
                : 'bg-gray-100 text-gray-600',
          ]"
          data-testid="rhythm-detail-status"
        >
          {{ RHYTHM_COLUMN_LABELS[activeCard.status] }}
        </span>
        <span class="text-[11px] text-gray-400">{{ activeCard.chapterRef }}</span>
      </div>

      <!-- 计划值编辑区（§七：滑块 + 下拉 + 角色输入） -->
      <div class="mb-2 shrink-0 rounded-md border border-gray-200 px-3 py-2.5" data-testid="rhythm-detail-planned">
        <p class="mb-2 text-[11px] font-medium text-gray-500">计划值（写前规划）</p>

        <div class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-xs text-gray-600">冲突强度</span>
          <input
            type="range"
            min="1"
            max="10"
            step="1"
            class="h-1.5 flex-1 accent-gray-900"
            :value="plannedConflictValue"
            data-testid="rhythm-detail-conflict-slider"
            :disabled="detailMode !== 'edit' || guard !== null"
            @input="emit('updateDraft', { plannedConflict: Number(($event.target as HTMLInputElement).value) })"
          >
          <span :class="['w-10 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold', plannedConflictValue >= 7 ? 'bg-red-100 text-red-700' : plannedConflictValue >= 4 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700']">
            {{ plannedConflictValue }}
          </span>
        </div>

        <div class="mt-2 grid grid-cols-3 gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">情绪基调</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 disabled:bg-gray-50 disabled:text-gray-500"
              :value="plannedMoodValue"
              data-testid="rhythm-detail-mood"
              :disabled="detailMode !== 'edit' || guard !== null"
              @change="emit('updateDraft', { plannedMood: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="mood in RHYTHM_MOODS" :key="mood" :value="mood" :title="RHYTHM_MOOD_DESCRIPTIONS[mood]">{{ mood }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">章末钩子</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 disabled:bg-gray-50 disabled:text-gray-500"
              :value="plannedHookValue"
              data-testid="rhythm-detail-hook"
              :disabled="detailMode !== 'edit' || guard !== null"
              @change="emit('updateDraft', { plannedHook: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="hook in RHYTHM_HOOKS" :key="hook" :value="hook">{{ hook }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">爽点类型</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 disabled:bg-gray-50 disabled:text-gray-500"
              :value="plannedPayoffValue"
              data-testid="rhythm-detail-payoff"
              :disabled="detailMode !== 'edit' || guard !== null"
              @change="emit('updateDraft', { plannedPayoff: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="payoff in RHYTHM_PAYOFFS" :key="payoff" :value="payoff">{{ payoff }}</option>
            </select>
          </label>
        </div>

        <div class="mt-2 flex flex-col gap-1">
          <span class="text-xs text-gray-600">出场角色（顿号分隔，可多选既有要素名）</span>
          <input
            type="text"
            class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 placeholder-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="如：林远、苏晚、老周"
            :value="plannedCharactersValue"
            data-testid="rhythm-detail-characters"
            :disabled="detailMode !== 'edit' || guard !== null"
            @input="onCharactersInput"
          >
        </div>

        <div class="mt-2 flex flex-col gap-1">
          <span class="text-xs text-gray-600">自然语言补充</span>
          <input
            type="text"
            class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 placeholder-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="计划里说不清的细节（可选）"
            :value="plannedNoteValue"
            data-testid="rhythm-detail-planned-note"
            :disabled="detailMode !== 'edit' || guard !== null"
            @input="onNoteInput"
          >
        </div>
      </div>

      <!-- 实际值展示区（只读：回写走 AI 写后同步提案，UI 不提供手改） -->
      <div
        v-if="isWritten"
        class="mb-2 shrink-0 rounded-md border px-3 py-2.5"
        :class="activeCard.deviationFlag ? 'border-red-200 bg-red-50/60' : 'border-emerald-200 bg-emerald-50/40'"
        data-testid="rhythm-detail-actual"
      >
        <p class="mb-1.5 text-[11px] font-medium text-gray-500">实际值（写后回写，只读）</p>
        <dl class="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
          <template v-for="row in actualRows" :key="row.label">
            <dt class="text-gray-500">{{ row.label }}</dt>
            <dd class="text-gray-700">计划 {{ row.planned }}</dd>
            <dd :class="activeCard.deviationFlag ? 'font-medium text-red-700' : 'text-emerald-700'">实际 {{ row.actual }}</dd>
          </template>
        </dl>
        <p v-if="activeCard.deviationNote" class="mt-1.5 text-[11px] leading-relaxed text-red-600">
          {{ activeCard.deviationNote }}
        </p>
        <p v-if="activeCard.actualNote" class="mt-1 text-[11px] text-gray-500">本章自评：{{ activeCard.actualNote }}</p>
        <p v-else-if="!activeCard.deviationFlag" class="mt-1 text-[11px] text-emerald-600">与计划一致 ✓</p>
      </div>

      <!-- 节奏意图正文（统一正文表面：预览/编辑；滚动列内保底高度，短高度随列滚动可达） -->
      <div class="flex min-h-40 flex-1 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-gray-500">节奏意图（本章要什么温度、不要什么）</p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          data-testid="rhythm-detail-intent"
          @dblclick="onIntentDblClick"
        >
          <!-- 纯文本预览（whitespace-pre-wrap）：intentBody 是 textarea 自由文本而非
               markdown 源——markdown 渲染会把段落内单换行折叠成空格（真机缺陷），且
               行首 #/列表标记/引号弯化都是意外变形；与 txt 文件预览同语义 -->
          <div
            v-if="intentBodyValue"
            class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
          >{{ intentBodyValue }}</div>
          <p v-else class="text-sm text-gray-400">双击或点击「编辑」补写本章的节奏意图。</p>
        </PlainBodySurface>
        <PlainBodySurface v-else variant="edit">
          <textarea
            :value="intentBodyValue"
            :readonly="guard !== null"
            class="min-h-24 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="本章要什么温度、不要什么；和前后章怎么衔接。"
            data-testid="rhythm-detail-intent-input"
            @input="onIntentInput"
          />
        </PlainBodySurface>
      </div>
      </div>
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
