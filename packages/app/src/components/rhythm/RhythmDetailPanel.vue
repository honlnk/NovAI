<script setup lang="ts">
import { computed } from 'vue'

import type { RhythmCardView } from '@novai/core/services/types'
import { RHYTHM_COLUMN_LABELS, RHYTHM_HOOKS, RHYTHM_MOODS, RHYTHM_MOOD_DESCRIPTIONS, RHYTHM_PAYOFFS } from '@novai/core/types/rhythm'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import type { DetailMode } from '../plan/detail-mode'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import DetailPanel from '../card-board/DetailPanel.vue'

/**
 * 节奏详情面板（§七）：计划值编辑区（冲突强度滑块、情绪/钩子/爽点下拉、出场
 * 角色多选输入、节奏意图文本）+ 实际值展示区（只读——回写走 AI 写后同步或直接
 * 编文件，UI 不提供手改 actual_*）+ 偏差说明。状态徽标只读展示：状态与偏差由
 * 系统按回写偏差自动判定，面板不提供状态按钮（DetailPanel columns 传空数组）。
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
  removeCard: [id: string]
}>()

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
  <DetailPanel
    :card-id="activeCard.id"
    :title-value="draftName ?? activeCard.name"
    title-placeholder="节奏卡名"
    :columns="[]"
    :active-column-key="activeCard.status"
    :pending-column-key="null"
    :detail-mode="detailMode"
    :save-phase="savePhase"
    :conflict="conflict"
    :conflict-fields="conflictFields"
    :guard="guard"
    :action-error="actionError"
    :updated-at="activeCard.updatedAt"
    delete-label="删除（移入回收站）"
    testid-prefix="rhythm"
    @close="emit('close')"
    @update-title="(value) => emit('updateDraft', { name: value })"
    @set-detail-mode="emit('setDetailMode', $event)"
    @retry-save="emit('retrySave')"
    @expand-conflict="emit('expandConflict')"
    @collapse-conflict="emit('collapseConflict')"
    @adopt-disk="emit('adoptDisk')"
    @adopt-mine="emit('adoptMine')"
    @save-copy="emit('saveCopy', $event)"
    @restore-as-copy="emit('restoreAsCopy', $event)"
    @discard-guard="emit('discardGuard')"
    @remove-card="emit('removeCard', activeCard.id)"
  >
    <template #content="{ detailMode: mode, frozen }">
      <!-- 状态徽标（只读：状态由回写偏差判定自动流转，不接受手改） -->
      <div class="mt-2 flex shrink-0 items-center gap-2">
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
      <div class="mt-2 shrink-0 rounded-md border border-gray-200 px-3 py-2.5" data-testid="rhythm-detail-planned">
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
            :disabled="mode !== 'edit' || frozen"
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
              :disabled="mode !== 'edit' || frozen"
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
              :disabled="mode !== 'edit' || frozen"
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
              :disabled="mode !== 'edit' || frozen"
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
            :disabled="mode !== 'edit' || frozen"
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
            :disabled="mode !== 'edit' || frozen"
            @input="onNoteInput"
          >
        </div>
      </div>

      <!-- 实际值展示区（只读：回写走 AI 写后同步提案，UI 不提供手改） -->
      <div
        v-if="isWritten"
        class="mt-2 shrink-0 rounded-md border px-3 py-2.5"
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

      <!-- 节奏意图正文（预览/编辑） -->
      <div class="mt-2 flex min-h-20 flex-1 flex-col overflow-hidden">
        <p class="mb-1 text-[11px] font-medium text-gray-500">节奏意图（本章要什么温度、不要什么）</p>
        <div
          v-if="mode === 'preview'"
          class="flex-1 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
          data-testid="rhythm-detail-intent"
          @dblclick="frozen ? undefined : emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="intentBodyValue" :content="intentBodyValue" />
          <p v-else class="text-sm text-gray-400">双击或点击「编辑」补写本章的节奏意图。</p>
        </div>
        <textarea
          v-else
          :value="intentBodyValue"
          :readonly="frozen"
          class="flex-1 w-full resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="本章要什么温度、不要什么；和前后章怎么衔接。"
          data-testid="rhythm-detail-intent-input"
          @input="onIntentInput"
        />
      </div>
    </template>
  </DetailPanel>
</template>
