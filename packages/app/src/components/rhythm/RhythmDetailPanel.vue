<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ChapterCatalog } from '@novai/core/types/chapters'
import type { RhythmCardView } from '@novai/core/services/types'
import type { RhythmJudgmentSource } from '@novai/core/types/rhythm'
import { RHYTHM_COLUMN_LABELS, RHYTHM_HOOKS, RHYTHM_MOODS, RHYTHM_MOOD_DESCRIPTIONS, RHYTHM_PAYOFFS, RHYTHM_STATUSES } from '@novai/core/types/rhythm'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import { describeChapterValue } from '../card-board/chapter-picker-state'
import type { ChapterCreateHandler } from '../card-board/chapter-picker-state'
import CardConflictBar from '../card-board/CardConflictBar.vue'
import CardConflictResolution from '../card-board/CardConflictResolution.vue'
import CardGuardNotice from '../card-board/CardGuardNotice.vue'
import CardSaveFailure from '../card-board/CardSaveFailure.vue'
import type { DetailMode } from '../layout/detail-mode'
import DetailLayout from '../layout/DetailLayout.vue'
import PlainBodySurface from '../layout/PlainBodySurface.vue'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

/**
 * 节奏详情面板（作者字段控制权计划阶段 3 §四固定布局 + 阶段 4 判定操作态）：
 * 状态徽标（含判定来源徽标）→ 关联章节选择器 → 计划值编辑区 → 常驻「写后
 * 实际值」区（未回写也可补填；编辑时并列计划参照）→ 判定与说明（有效结论 +
 * 作者校正表单 + 恢复自动两步确认 + 阈值提示 + 历史人工说明）→ 默认折叠
 * 「更多正文」→ 节奏意图正文。状态徽标只读：判定默认自动，作者经「作者校正 /
 * 恢复自动判定」明确操作接管（应用是显式保存：与同轮未保存修改合并一次落盘）。
 */
const props = defineProps<{
  activeCard: RhythmCardView
  /** 判定来源（阶段 4）：徽标与恢复自动入口的展示依据 */
  judgmentSource: RhythmJudgmentSource
  /** 阈值待复核（§五.3）：最近判定阈值与当前项目阈值不一致的轻量提示 */
  thresholdPending: boolean
  /** 历史人工说明：恢复自动后保留的作者说明（默认折叠查看） */
  historicalAuthorNote: string | null
  /** 作者卡上正在修改比较值：保存前明确提示将恢复自动（§五.3） */
  comparisonEditWarning: boolean
  /** 恢复自动确认预演（磁盘卡 + 草稿合并值按当前阈值的自动结论） */
  restoreAutoPreview: { status: RhythmCardView['status']; deviationFlag: boolean; deviationNote: string | null } | null
  /** 待确认的作者校正表单（null = 不在操作态） */
  authorCorrection: { status: string; deviationFlag: boolean; deviationNote: string } | null
  /** 跨列拖拽的待确认落点描述（阶段 5 §六；null = 无暂存移动） */
  correctionPlacement: string | null
  /** 待确认的恢复自动判定（两步确认第二步） */
  restoreAutoPending: boolean
  /** 应用校正/确认恢复自动可点（无冲突守护，操作态中） */
  canConfirmAuthorCorrection: boolean
  canConfirmRestoreAuto: boolean
  /** 显式判定保存进行中 */
  isConfirmingJudgment: boolean
  draftName: string | null
  draftChapterRef: string | null
  draftPlannedConflict: number | null
  draftPlannedMood: string | null
  draftPlannedHook: string | null
  draftPlannedPayoff: string | null
  draftPlannedCharacters: string | null
  draftPlannedNote: string | null
  draftIntentBody: string | null
  /** 实际值草稿（null = 未修改；0/'' = 清除） */
  draftActualConflict: number | null
  draftActualMood: string | null
  draftActualHook: string | null
  draftActualPayoff: string | null
  draftActualNote: string | null
  draftLinkBody: string | null
  draftAuthorNoteBody: string | null
  /** 章节选择器接线（目录、真实新建与重试来自视图层的同一 composable） */
  picker: {
    catalog: ChapterCatalog
    catalogReady: boolean
    loading: boolean
    loadError: string | null
    suggestedNumber: number | null
    createHandler: ChapterCreateHandler | null
    sessionKey: string
    latestChapterNumber: number | null
  }
  /** 「章节已创建，卡片引用尚未保存」提示（§三.4） */
  chapterCreateNotice: string | null
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
    chapterRef?: string
    plannedConflict?: number
    plannedMood?: string
    plannedHook?: string
    plannedPayoff?: string
    plannedCharacters?: string
    plannedNote?: string
    intentBody?: string
    actualConflict?: number
    actualMood?: string
    actualHook?: string
    actualPayoff?: string
    actualNote?: string
    linkBody?: string
    authorNoteBody?: string
  }]
  setDetailMode: [mode: DetailMode]
  retrySave: []
  retryChapterLoad: []
  expandConflict: []
  collapseConflict: []
  adoptDisk: []
  adoptMine: []
  saveCopy: [name: string]
  restoreAsCopy: [name: string]
  discardGuard: []
  /** 判定操作态（阶段 4）：进入/更新/取消/应用校正与恢复自动 */
  startAuthorCorrection: []
  updateAuthorCorrection: [patch: { status?: string; deviationFlag?: boolean; deviationNote?: string }]
  cancelAuthorCorrection: []
  confirmAuthorCorrection: []
  startRestoreAuto: []
  cancelRestoreAuto: []
  confirmRestoreAuto: []
}>()

/** 头部名称输入展示值（草稿优先） */
const titleValue = computed(() => props.draftName ?? props.activeCard.name)
const isEditing = computed(() => props.detailMode === 'edit' && props.guard === null)
const moreOpen = ref(false)

/* ---------- 展示值：有草稿显示草稿（预览态也跟随未保存修改） ---------- */

const plannedConflictValue = computed(() => props.draftPlannedConflict ?? props.activeCard.plannedConflict)
const plannedMoodValue = computed(() => props.draftPlannedMood ?? props.activeCard.plannedMood)
const plannedHookValue = computed(() => props.draftPlannedHook ?? props.activeCard.plannedHook)
const plannedPayoffValue = computed(() => props.draftPlannedPayoff ?? props.activeCard.plannedPayoff)
const plannedCharactersValue = computed(() => props.draftPlannedCharacters ?? props.activeCard.plannedCharacters.join('、'))
const plannedNoteValue = computed(() => props.draftPlannedNote ?? (props.activeCard.plannedNote ?? ''))
const intentBodyValue = computed(() => props.draftIntentBody ?? props.activeCard.intentBody)
const linkBodyValue = computed(() => props.draftLinkBody ?? props.activeCard.linkBody)
const authorNoteBodyValue = computed(() => props.draftAuthorNoteBody ?? props.activeCard.authorNoteBody)

const chapterRefValue = computed(() => (props.draftChapterRef ?? props.activeCard.chapterRef).trim())
/** 关联章节预览描述（未就绪时退回原文） */
const chapterDescribe = computed(() => describeChapterValue(props.picker.catalog, props.picker.catalogReady, chapterRefValue.value || null))
/** 关联章节是否为无法归类的兼容原文（有目录且既非真实引用也非章号形态） */
const chapterIsRaw = computed(() =>
  props.picker.catalogReady
  && chapterRefValue.value !== ''
  && !props.picker.catalog.entries.some((entry) => entry.ref === chapterRefValue.value)
  && /第\d+章/.exec(chapterRefValue.value) === null)

/* ---------- 实际值：解析草稿哨兵（null=未修改 / 0·''=清除 / 值=已填） ---------- */

/** 实际冲突强度有效值：null = 未填写 */
const actualConflictValue = computed(() => {
  const draft = props.draftActualConflict
  if (draft != null) {
    return draft === 0 ? null : draft
  }
  return props.activeCard.actualConflict
})
const actualConflictFilled = computed(() => actualConflictValue.value !== null)

const actualMoodValue = computed(() => {
  const draft = props.draftActualMood
  return draft != null ? draft : (props.activeCard.actualMood ?? '')
})
const actualHookValue = computed(() => {
  const draft = props.draftActualHook
  return draft != null ? draft : (props.activeCard.actualHook ?? '')
})
const actualPayoffValue = computed(() => {
  const draft = props.draftActualPayoff
  return draft != null ? draft : (props.activeCard.actualPayoff ?? '')
})
const actualNoteValue = computed(() => props.draftActualNote ?? (props.activeCard.actualNote ?? ''))

/** 已填写的实际值维度数（判定说明口径：自评不算「已写」证据） */
const actualFilledCount = computed(() =>
  [actualConflictValue.value, actualMoodValue.value, actualHookValue.value, actualPayoffValue.value]
    .filter((value) => value !== null && value !== '').length)

/** 计划↔实际对照行（预览与编辑共用的参照） */
const compareRows = computed(() => [
  { key: 'conflict', label: '冲突强度', planned: String(plannedConflictValue.value), actual: actualConflictValue.value === null ? null : String(actualConflictValue.value) },
  { key: 'mood', label: '情绪基调', planned: plannedMoodValue.value, actual: actualMoodValue.value === '' ? null : actualMoodValue.value },
  { key: 'hook', label: '章末钩子', planned: plannedHookValue.value, actual: actualHookValue.value === '' ? null : actualHookValue.value },
  { key: 'payoff', label: '爽点类型', planned: plannedPayoffValue.value, actual: actualPayoffValue.value === '' ? null : actualPayoffValue.value },
])

const judgmentHint = computed(() => {
  if (props.savePhase === 'pending' || props.savePhase === 'saving') {
    return '保存后将按项目阈值重新判定'
  }
  return null
})

/* ---------- 判定操作态（阶段 4 §五） ---------- */

/** 有效偏差说明：作者卡用作者说明，自动卡用系统判定说明 */
const effectiveDeviationNote = computed(() =>
  props.judgmentSource === 'author' ? props.activeCard.authorDeviationNote : props.activeCard.deviationNote)

/** 校正表单的门禁派生（§五.2 校验表的界面预检；最终校验在服务层） */
const correctionStatus = computed(() => props.authorCorrection?.status ?? 'planned')
const correctionDeviationFlag = computed(() => props.authorCorrection?.deviationFlag ?? false)
const correctionNoteMissing = computed(() =>
  correctionDeviationFlag.value && (props.authorCorrection?.deviationNote ?? '').trim() === '')
/** 已写/偏差需要四项实际比较值至少一项（本章自评不计入；按合并后的草稿口径） */
const correctionNeedsActual = computed(() => correctionStatus.value !== 'planned' && actualFilledCount.value === 0)
const correctionKeepsActual = computed(() => correctionStatus.value === 'planned' && actualFilledCount.value > 0)
const canApplyCorrection = computed(() => !correctionNoteMissing.value && !correctionNeedsActual.value)

/** 当前作者结论与恢复后自动结论的展示标签（两步确认的对照） */
const authorConclusionLabel = computed(() =>
  `${RHYTHM_COLUMN_LABELS[props.activeCard.status]} · ${props.activeCard.deviationFlag ? '有偏差' : '无偏差'}`)
const restorePreviewLabel = computed(() => {
  const preview = props.restoreAutoPreview
  if (!preview) {
    return '—'
  }
  return `${RHYTHM_COLUMN_LABELS[preview.status]} · ${preview.deviationFlag ? '有偏差' : '无偏差'}`
})

function onCorrectionStatusChange(event: Event) {
  const status = (event.target as HTMLSelectElement).value
  emit('updateAuthorCorrection', {
    status,
    // 校验表联动：规划中只能无偏差、偏差状态必须有偏差（已写由作者自选）
    ...(status === 'planned' ? { deviationFlag: false } : {}),
    ...(status === 'deviated' ? { deviationFlag: true } : {}),
  })
}

function onCorrectionFlagChange(event: Event) {
  emit('updateAuthorCorrection', { deviationFlag: (event.target as HTMLSelectElement).value === 'deviation' })
}

function onTitleInput(event: Event) {
  emit('updateDraft', { name: (event.target as HTMLInputElement).value })
}

function onIntentInput(event: Event) {
  emit('updateDraft', { intentBody: (event.target as HTMLTextAreaElement).value })
}

function onLinkInput(event: Event) {
  emit('updateDraft', { linkBody: (event.target as HTMLTextAreaElement).value })
}

function onAuthorNoteInput(event: Event) {
  emit('updateDraft', { authorNoteBody: (event.target as HTMLTextAreaElement).value })
}

function onActualNoteInput(event: Event) {
  emit('updateDraft', { actualNote: (event.target as HTMLTextAreaElement).value })
}

function onNoteInput(event: Event) {
  emit('updateDraft', { plannedNote: (event.target as HTMLInputElement).value })
}

function onCharactersInput(event: Event) {
  emit('updateDraft', { plannedCharacters: (event.target as HTMLInputElement).value })
}

function onChapterPick(value: string | string[] | null) {
  if (typeof value === 'string' && value !== '') {
    emit('updateDraft', { chapterRef: value })
  }
}

/** 滑块输入：直接进入已填状态 */
function onActualConflictInput(event: Event) {
  emit('updateDraft', { actualConflict: Number((event.target as HTMLInputElement).value) })
}

/** 「按计划值填写」：从计划值起步（用户再调） */
function fillActualConflict() {
  emit('updateDraft', { actualConflict: plannedConflictValue.value })
}
</script>

<template>
  <DetailLayout
    :mode="detailMode"
    :has-content="true"
    :save-phase="savePhase"
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

    <!-- 主内容（§四.1 固定布局）：短高度下整列纵向滚动（本区是滚动责任方），
         DetailLayout 固定底部路径/时间不参与滚动 -->
    <template #content>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="rhythm-detail-scroll">
      <!-- 1. 当前状态（只读：判定默认自动，作者可经判定与说明区明确校正/恢复） -->
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
        <span
          v-if="judgmentSource === 'author'"
          class="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700"
          data-testid="rhythm-detail-judgment-badge"
        >作者校正</span>
        <span v-else-if="activeCard.status !== 'planned'" class="text-[11px] text-gray-400">判定：自动（回写时按阈值计算）</span>
      </div>

      <!-- 2. 关联章节（编辑：可搜索选择器 + 真实新建；预览：统一位置语义描述） -->
      <div class="mb-2 shrink-0 rounded-md border border-gray-200 px-3 py-2" data-testid="rhythm-detail-chapter">
        <p class="mb-1.5 text-[11px] font-medium text-gray-500">关联章节（一章一卡）</p>
        <template v-if="isEditing">
          <p v-if="chapterIsRaw" class="mb-1 rounded bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">
            兼容原文：「{{ chapterRefValue }}」——改为真实章节或新建后保存才会更新为章节引用。
          </p>
          <ChapterPicker
            :model-value="chapterIsRaw ? null : (chapterRefValue === '' ? null : chapterRefValue)"
            :entries="picker.catalog.entries"
            :catalog-ready="picker.catalogReady"
            :loading="picker.loading"
            :load-error="picker.loadError"
            allow-create
            :suggested-number="picker.suggestedNumber"
            :session-key="`${picker.sessionKey}:chapter`"
            :create-handler="picker.createHandler"
            placeholder="搜索并选择关联章节（必填）…"
            @update:model-value="onChapterPick"
            @retry-load="emit('retryChapterLoad')"
          />
        </template>
        <p v-else class="text-xs text-gray-700">
          {{ chapterDescribe.text }}
          <span v-if="chapterDescribe.badge" :class="chapterDescribe.badge.tone === 'warn' ? 'ml-1 text-amber-600' : 'ml-1 text-gray-400'">{{ chapterDescribe.badge.label }}</span>
        </p>
        <p v-if="chapterCreateNotice" class="mt-1.5 rounded-md border border-blue-200 bg-blue-50/60 px-2.5 py-1.5 text-[11px] text-blue-700" data-testid="rhythm-detail-chapter-created-notice">
          {{ chapterCreateNotice }}
        </p>
      </div>

      <!-- 3. 计划值编辑区（滑块 + 下拉 + 角色输入） -->
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
            :disabled="!isEditing"
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
              :disabled="!isEditing"
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
              :disabled="!isEditing"
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
              :disabled="!isEditing"
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
            :disabled="!isEditing"
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
            :disabled="!isEditing"
            @input="onNoteInput"
          >
        </div>
      </div>

      <!-- 4. 写后实际值（常驻可见：未回写也可补填；编辑时并列计划参照） -->
      <div
        class="mb-2 shrink-0 rounded-md border px-3 py-2.5"
        :class="activeCard.deviationFlag ? 'border-red-200 bg-red-50/60' : actualFilledCount > 0 ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'"
        data-testid="rhythm-detail-actual"
      >
        <p class="mb-1.5 text-[11px] font-medium text-gray-500">写后实际值（未回写也可先补填；不写回章节文件）</p>

        <template v-if="isEditing">
          <!-- 编辑态：控件 + 计划参照 -->
          <div class="flex items-center gap-2">
            <span class="w-16 shrink-0 text-xs text-gray-600">冲突强度</span>
            <template v-if="actualConflictFilled">
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                class="h-1.5 flex-1 accent-gray-900"
                :value="actualConflictValue ?? plannedConflictValue"
                data-testid="rhythm-detail-actual-conflict-slider"
                @input="onActualConflictInput"
              >
              <span :class="['w-10 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold', (actualConflictValue ?? 0) >= 7 ? 'bg-red-100 text-red-700' : (actualConflictValue ?? 0) >= 4 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700']">
                {{ actualConflictValue }}
              </span>
              <button
                type="button"
                class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100"
                data-testid="rhythm-detail-actual-conflict-clear"
                @click="emit('updateDraft', { actualConflict: 0 })"
              >未填写</button>
            </template>
            <template v-else>
              <span class="flex-1 text-xs text-gray-400">未填写</span>
              <button
                type="button"
                class="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-50"
                data-testid="rhythm-detail-actual-conflict-fill"
                @click="fillActualConflict"
              >按计划值填写</button>
            </template>
          </div>

          <div class="mt-2 grid grid-cols-3 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs text-gray-600">情绪基调</span>
              <select
                class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
                :value="actualMoodValue"
                data-testid="rhythm-detail-actual-mood"
                @change="emit('updateDraft', { actualMood: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">未填写</option>
                <option v-for="mood in RHYTHM_MOODS" :key="mood" :value="mood" :title="RHYTHM_MOOD_DESCRIPTIONS[mood]">{{ mood }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs text-gray-600">章末钩子</span>
              <select
                class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
                :value="actualHookValue"
                data-testid="rhythm-detail-actual-hook"
                @change="emit('updateDraft', { actualHook: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">未填写</option>
                <option v-for="hook in RHYTHM_HOOKS" :key="hook" :value="hook">{{ hook }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs text-gray-600">爽点类型</span>
              <select
                class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
                :value="actualPayoffValue"
                data-testid="rhythm-detail-actual-payoff"
                @change="emit('updateDraft', { actualPayoff: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">未填写</option>
                <option v-for="payoff in RHYTHM_PAYOFFS" :key="payoff" :value="payoff">{{ payoff }}</option>
              </select>
            </label>
          </div>

          <div class="mt-2 flex flex-col gap-1">
            <span class="text-xs text-gray-600">本章自评（作者与 AI 都能写；不参与偏差比较）</span>
            <textarea
              class="min-h-16 w-full resize-none rounded-md border border-gray-200 px-2.5 py-2 text-xs leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="写完本章后对节奏落地的复盘（可选）"
              data-testid="rhythm-detail-actual-note"
              :value="actualNoteValue"
              @input="onActualNoteInput"
            />
          </div>

          <!-- 计划参照（编辑时保持可见，不因进编辑就隐藏） -->
          <dl class="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 border-t border-gray-200 pt-2 text-xs">
            <template v-for="row in compareRows" :key="row.key">
              <dt class="text-gray-400">{{ row.label }}</dt>
              <dd class="text-gray-500">计划 {{ row.planned }}</dd>
              <dd class="text-gray-600">实际 {{ row.actual ?? '—' }}</dd>
            </template>
          </dl>
        </template>

        <template v-else>
          <!-- 预览态：计划↔实际对照 -->
          <dl class="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
            <template v-for="row in compareRows" :key="row.key">
              <dt class="text-gray-500">{{ row.label }}</dt>
              <dd class="text-gray-700">计划 {{ row.planned }}</dd>
              <dd :class="activeCard.deviationFlag ? 'font-medium text-red-700' : 'text-emerald-700'">实际 {{ row.actual ?? '—' }}</dd>
            </template>
          </dl>
          <p v-if="activeCard.actualNote" class="mt-1.5 text-[11px] text-gray-500">本章自评：{{ activeCard.actualNote }}</p>
          <p v-if="actualFilledCount === 0" class="mt-1 text-[11px] text-gray-400">尚未回写实际值；点击「编辑」可直接补填。</p>
        </template>
      </div>

      <!-- 5. 判定与说明（阶段 4：有效结论 + 作者校正表单 + 恢复自动两步确认 +
           阈值提示 + 比较值警告 + 历史人工说明） -->
      <div class="mb-2 shrink-0 rounded-md border px-3 py-2" :class="judgmentSource === 'author' ? 'border-amber-200' : 'border-gray-200'" data-testid="rhythm-detail-judgment">
        <p class="mb-1 text-[11px] font-medium text-gray-500">
          判定与说明
          <span class="ml-1 font-normal text-gray-400">{{ judgmentSource === 'author' ? '当前为作者校正结论' : '按计划值、实际值与项目阈值自动判定' }}</span>
        </p>
        <p v-if="activeCard.deviationFlag" class="text-xs font-medium text-red-700">
          偏差（{{ judgmentSource === 'author' ? '作者校正' : '自动判定' }}）
          <span class="ml-1 font-normal">{{ effectiveDeviationNote }}</span>
        </p>
        <p v-else-if="activeCard.status === 'written'" class="text-xs text-emerald-700">已写：与计划一致（{{ judgmentSource === 'author' ? '作者校正' : '自动判定' }}）</p>
        <p v-else class="text-xs text-gray-500">规划中：尚未回写实际值，不参与偏差判定</p>

        <p v-if="judgmentHint" class="mt-1 text-[11px] text-amber-600">{{ judgmentHint }}</p>
        <p v-if="comparisonEditWarning" class="mt-1 text-[11px] text-amber-600" data-testid="rhythm-detail-comparison-warning">
          正在修改计划/实际比较值：保存后将按新值重算并恢复自动判定。
        </p>
        <p v-if="thresholdPending" class="mt-1 text-[11px] text-amber-600" data-testid="rhythm-detail-threshold-pending">
          阈值已变化，可重新检查{{ judgmentSource === 'author' ? '（人工结论保留，恢复自动后按新阈值重算）' : '' }}
        </p>

        <!-- 入口（无待确认操作态时） -->
        <div v-if="!authorCorrection && !restoreAutoPending" class="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            class="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-50"
            data-testid="rhythm-detail-correct-button"
            @click="emit('startAuthorCorrection')"
          >作者校正</button>
          <button
            v-if="judgmentSource === 'author'"
            type="button"
            class="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-50"
            data-testid="rhythm-detail-restore-auto-button"
            @click="emit('startRestoreAuto')"
          >恢复自动判定</button>
        </div>

        <!-- 作者校正表单（原位展开） -->
        <div v-if="authorCorrection" class="mt-2 rounded-md border border-blue-200 bg-blue-50/50 px-2.5 py-2" data-testid="rhythm-detail-correction-form">
          <p class="mb-1.5 text-[11px] font-medium text-blue-700">作者校正（明确操作：应用时与未保存修改合并为一次保存）</p>
          <p v-if="correctionPlacement" class="mb-1.5 text-[11px] text-blue-700" data-testid="rhythm-detail-correction-placement">
            {{ correctionPlacement }}
          </p>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs text-gray-600">状态</span>
              <select
                class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
                :value="correctionStatus"
                data-testid="rhythm-detail-correction-status"
                @change="onCorrectionStatusChange"
              >
                <option v-for="status in RHYTHM_STATUSES" :key="status" :value="status">{{ RHYTHM_COLUMN_LABELS[status] }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs text-gray-600">偏差结论</span>
              <select
                class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
                :value="correctionDeviationFlag ? 'deviation' : 'none'"
                data-testid="rhythm-detail-correction-flag"
                @change="onCorrectionFlagChange"
              >
                <option value="none" :disabled="correctionStatus === 'deviated'">无偏差</option>
                <option value="deviation" :disabled="correctionStatus === 'planned'">有偏差</option>
              </select>
            </label>
          </div>
          <div class="mt-2 flex flex-col gap-1">
            <span class="text-xs text-gray-600">偏差说明（有偏差时必填；无偏差时留空并清除旧说明）</span>
            <textarea
              class="min-h-14 w-full resize-none rounded-md border border-gray-200 px-2.5 py-2 text-xs leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="作者口径的偏差说明（为何这章与计划不同、为何算/不算偏差）"
              data-testid="rhythm-detail-correction-note"
              :value="authorCorrection.deviationNote"
              @input="emit('updateAuthorCorrection', { deviationNote: ($event.target as HTMLTextAreaElement).value })"
            />
          </div>
          <p v-if="correctionNeedsActual" class="mt-1 text-[11px] text-amber-600" data-testid="rhythm-detail-correction-needs-actual">
            「已写 / 偏差」需要冲突、情绪、钩子、爽点四项实际比较值中至少一项已填写（本章自评不计入）。
          </p>
          <p v-if="correctionKeepsActual" class="mt-1 text-[11px] text-gray-400" data-testid="rhythm-detail-correction-keeps-actual">
            校正为「规划中」不清空已填实际值；它们保留，仅分类回到规划中。
          </p>
          <p v-if="correctionNoteMissing" class="mt-1 text-[11px] text-amber-600" data-testid="rhythm-detail-correction-note-missing">
            有偏差时必须填写偏差说明。
          </p>
          <div class="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              class="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="rhythm-detail-correction-apply"
              :disabled="!canApplyCorrection || !canConfirmAuthorCorrection || isConfirmingJudgment"
              @click="emit('confirmAuthorCorrection')"
            >{{ isConfirmingJudgment ? '应用中…' : '应用校正' }}</button>
            <button
              type="button"
              class="rounded border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-50"
              data-testid="rhythm-detail-correction-cancel"
              @click="emit('cancelAuthorCorrection')"
            >取消</button>
          </div>
        </div>

        <!-- 恢复自动判定（两步确认） -->
        <div v-if="restoreAutoPending" class="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-2" data-testid="rhythm-detail-restore-auto">
          <p class="mb-1.5 text-[11px] font-medium text-amber-700">恢复自动判定（明确操作：确认后立即按最新值与阈值重算保存）</p>
          <p class="text-xs text-gray-700">当前作者结论：{{ authorConclusionLabel }}</p>
          <p class="mt-0.5 text-xs text-gray-700" data-testid="rhythm-detail-restore-auto-preview">
            恢复后自动结论：{{ restorePreviewLabel }}
            <span v-if="restoreAutoPreview?.deviationNote" class="mt-0.5 block text-[11px] text-gray-500">{{ restoreAutoPreview.deviationNote }}</span>
          </p>
          <p class="mt-1 text-[11px] text-gray-400">不清空实际值；本说明保留为「历史人工说明」。</p>
          <div class="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              class="rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="rhythm-detail-restore-auto-confirm"
              :disabled="!canConfirmRestoreAuto || isConfirmingJudgment"
              @click="emit('confirmRestoreAuto')"
            >{{ isConfirmingJudgment ? '恢复中…' : '确认恢复自动' }}</button>
            <button
              type="button"
              class="rounded border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-50"
              data-testid="rhythm-detail-restore-auto-cancel"
              @click="emit('cancelRestoreAuto')"
            >取消</button>
          </div>
        </div>

        <!-- 历史人工说明（恢复自动后保留的作者说明，默认折叠） -->
        <details v-if="historicalAuthorNote" class="mt-1.5" data-testid="rhythm-detail-historical-note">
          <summary class="cursor-pointer text-[11px] text-gray-400">历史人工说明（恢复自动判定前的作者说明）</summary>
          <p class="mt-1 rounded bg-gray-50 px-2 py-1 text-[11px] leading-relaxed text-gray-600">{{ historicalAuthorNote }}</p>
        </details>
      </div>

      <!-- 6. 更多正文（默认折叠：上下文衔接 / 作者备注） -->
      <section class="mb-2 shrink-0 rounded-md border border-gray-200 bg-gray-50 text-xs" data-testid="rhythm-detail-more">
        <button
          type="button"
          class="flex w-full items-center justify-between px-3 py-2 text-left text-gray-600 transition-colors hover:bg-gray-100"
          data-testid="rhythm-detail-more-toggle"
          @click="moreOpen = !moreOpen"
        >
          <span>更多正文</span>
          <span class="text-gray-400">{{ moreOpen ? '收起 ▴' : '上下文衔接、作者备注 ▾' }}</span>
        </button>

        <div v-if="moreOpen" class="space-y-3 border-t border-gray-200 px-3 py-2.5">
          <div class="flex flex-col gap-1">
            <p class="text-[11px] font-medium text-gray-500">上下文衔接（前后章的温度差）</p>
            <PlainBodySurface v-if="!isEditing" variant="preview" data-testid="rhythm-detail-link">
              <!-- 纯文本预览（whitespace-pre-wrap）：上下文衔接是 textarea 自由文本而非
                   markdown 源——markdown 渲染会折叠段内单换行，与 txt 文件预览同语义 -->
              <div
                v-if="linkBodyValue"
                class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
              >{{ linkBodyValue }}</div>
              <p v-else class="text-sm text-gray-400">未填写。</p>
            </PlainBodySurface>
            <textarea
              v-else
              class="min-h-20 w-full resize-none rounded-md border border-gray-200 px-2.5 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="和前后章怎么接：上一章的温度如何过渡到本章、本章结尾为下一章留了什么。"
              data-testid="rhythm-detail-link-input"
              :value="linkBodyValue"
              @input="onLinkInput"
            />
          </div>

          <div class="flex flex-col gap-1">
            <p class="text-[11px] font-medium text-gray-500">作者备注</p>
            <PlainBodySurface v-if="!isEditing" variant="preview" data-testid="rhythm-detail-author-note">
              <!-- 纯文本预览（whitespace-pre-wrap）：作者备注是 textarea 自由文本而非
                   markdown 源——markdown 渲染会折叠段内单换行，与 txt 文件预览同语义 -->
              <div
                v-if="authorNoteBodyValue"
                class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
              >{{ authorNoteBodyValue }}</div>
              <p v-else class="text-sm text-gray-400">未填写。</p>
            </PlainBodySurface>
            <textarea
              v-else
              class="min-h-20 w-full resize-none rounded-md border border-gray-200 px-2.5 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="给未来的自己或协作 AI 看的备注（可选）。"
              data-testid="rhythm-detail-author-note-input"
              :value="authorNoteBodyValue"
              @input="onAuthorNoteInput"
            />
          </div>
        </div>
      </section>

      <!-- 7. 节奏意图正文（统一正文表面：预览/编辑） -->
      <div class="flex min-h-40 flex-1 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-gray-500">节奏意图（本章要什么温度、不要什么）</p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          data-testid="rhythm-detail-intent"
          @dblclick="guard ? undefined : emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="intentBodyValue" :content="intentBodyValue" />
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
