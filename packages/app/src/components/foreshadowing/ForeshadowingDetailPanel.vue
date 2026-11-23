<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'

import type { ChapterCatalog } from '@novai/core/types/chapters'
import type { ForeshadowingCardView, ForeshadowingStatusView } from '@novai/core/services/types'
import { FORESHADOWING_STATUSES, FORESHADOWING_STATUS_LABELS } from '@novai/core/types/foreshadowing'
import { useTransientEdit } from '../../composables/useTransientEdit'
import type { PlannedPosition, PlannedWindowEnd } from '@novai/core/types/foreshadowing'
import {
  effectivePlannedWindow,
  formatPlannedPosition,
  parsePlannedPosition,
} from '@novai/core/services/foreshadowing-service'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import { plannedWindowDisplay } from '../../stores/foreshadowing'
import CardConflictBar from '../card-board/CardConflictBar.vue'
import CardConflictResolution from '../card-board/CardConflictResolution.vue'
import CardGuardNotice from '../card-board/CardGuardNotice.vue'
import CardSaveFailure from '../card-board/CardSaveFailure.vue'
import CardStatusTools from '../card-board/CardStatusTools.vue'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import { describeChapterValue } from '../card-board/chapter-picker-state'
import type { ChapterCreateHandler } from '../card-board/chapter-picker-state'
import PlannedPositionPicker from './PlannedPositionPicker.vue'
import type { DetailMode } from '../layout/detail-mode'
import DetailLayout from '../layout/DetailLayout.vue'
import PlainBodySurface from '../layout/PlainBodySurface.vue'

/**
 * 伏笔详情面板：统一详情布局（components/layout/DetailLayout.vue）的伏笔领域
 * 装配。正文三件（名/读者视角/作者真相）+ 状态走草稿两秒保存；结构字段收进
 * 默认折叠的「高级信息」（作者字段控制权计划阶段 2 §三）：埋设章节、计划回收
 * 窗口（起点/终点位置选择器）、关联角色/物品、暗示历史（作者可整理）、红鲱鱼、
 * 实际回收章节（不隐式清空、状态不一致就地表态）、历史放弃原因（「修订原因」
 * 明确操作）。窗口两套数据不一致时并列展示三个固定出口；预览模式展示已有值
 * 及明确的「未设置」，编辑模式展示控件。
 */
const props = defineProps<{
  activeCard: ForeshadowingCardView
  draftName: string | null
  draftReaderView: string | null
  draftAuthorTruth: string | null
  /** 待保存的普通状态（状态按钮等待标记）；null = 无状态修改 */
  draftStatus: ForeshadowingStatusView | null
  // —— 高级信息草稿（null = 未修改；位置为编码字符串）——
  draftPlantedAt: string | null
  draftPayoffStart: string | null
  draftPayoffEnd: string | null
  draftRelatedCharactersText: string | null
  draftRelatedEntitiesText: string | null
  /** 关联章节：换行连接的引用列表文本 */
  draftRelatedChapters: string | null
  draftIsRedHerring: boolean | null
  /** 实际回收章节草稿；空串 = 清除 */
  draftResolvedAt: string | null
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
  /** 章节已创建但卡片引用尚未保存的提示（null = 无） */
  chapterCreateNotice: string | null
  /** 回收窗口两套数据不一致（三出口展示条件） */
  windowMismatch: boolean
  windowMismatchViews: { structured: string; legacy: string } | null
  /** 字段收口完成（clean）才允许窗口出口执行 */
  canAdoptWindow: boolean
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
  /** 待确认的放弃操作态（null = 不在操作态；原因输入绑定） */
  abandonIntent: { reason: string } | null
  /** 确认放弃可点（字段收口完成 clean）；收口中/冲突时禁用 */
  canConfirmAbandon: boolean
  /** 确认放弃进行中（防重复提交） */
  isConfirmingAbandon: boolean
  /** 待确认的放弃原因修订操作态（null = 不在操作态） */
  reasonRevision: { reason: string } | null
  /** 应用修订可点（字段收口完成 clean）；收口中/冲突时禁用 */
  canConfirmReasonRevision: boolean
  /** 应用修订进行中（防重复提交） */
  isConfirmingReasonRevision: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateDraftName: [name: string]
  updateDraftReaderView: [readerView: string]
  updateDraftAuthorTruth: [authorTruth: string]
  updateDraftStatus: [status: ForeshadowingStatusView]
  updateDraftPlantedAt: [plantedAt: string]
  updateDraftPayoffStart: [payoffStart: string]
  updateDraftPayoffEnd: [payoffEnd: string]
  updateDraftRelatedCharactersText: [text: string]
  updateDraftRelatedEntitiesText: [text: string]
  updateDraftRelatedChapters: [chapters: string[]]
  updateDraftIsRedHerring: [isRedHerring: boolean]
  updateDraftResolvedAt: [resolvedAt: string]
  retryChapterLoad: []
  adoptStructuredWindow: []
  adoptLegacyWindow: []
  dismissWindowMismatch: []
  startReasonRevision: []
  updateReasonRevision: [reason: string]
  cancelReasonRevision: []
  confirmReasonRevision: []
  /** 进入放弃操作态（「已放弃」状态选择的拦截出口，不登记状态） */
  startAbandon: []
  updateAbandonReason: [reason: string]
  cancelAbandon: []
  confirmAbandon: []
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

const statusButtons = computed(() =>
  FORESHADOWING_STATUSES.map((status) => ({ key: status, label: FORESHADOWING_STATUS_LABELS[status] })),
)

/** 头部名称输入展示值（草稿优先） */
const titleValue = computed(() => props.draftName ?? props.activeCard.name)

/** 读者视角展示值：有草稿显示草稿 */
const readerValue = computed(() => props.draftReaderView ?? props.activeCard.readerBody)
/** 作者真相展示值：有草稿显示草稿 */
const truthValue = computed(() => props.draftAuthorTruth ?? props.activeCard.authorTruth)

/* ---------- 临时编辑（双击快改即走）：静置无改动亮「等待保存」并同窗收口回预览，有改动自动保存完成回预览 ---------- */
const { markTransient, displaySavePhase } = useTransientEdit({
  savePhase: toRef(props, 'savePhase'),
  detailMode: toRef(props, 'detailMode'),
  onReturnToPreview: () => emit('setDetailMode', 'preview'),
})
/** 预览态双击正文（读者视角/作者真相任一区）进入临时编辑；点「编辑」按钮进入的常规编辑不受影响 */
function onBodyDblClick() {
  if (props.guard) return
  markTransient()
  emit('setDetailMode', 'edit')
}

const payoffWindowText = computed(() =>
  props.activeCard.payoffWindow
    ? `${props.activeCard.payoffWindow[0]} ~ ${props.activeCard.payoffWindow[1]}`
    : '未设定',
)

/* ---------- 高级信息（阶段 2：默认折叠，折叠/展开不产生保存） ---------- */

const advancedOpen = ref(false)
/** 三出口的「返回」只收起横幅（两套数据与当前输入都保留），重开卡片再现 */
const mismatchDismissed = ref(false)

watch(() => props.activeCard.id, () => {
  mismatchDismissed.value = false
})
// 修订操作态激活时确保高级信息展开（否则找不到入口）
watch(() => props.reasonRevision, (revision) => {
  if (revision !== null) {
    advancedOpen.value = true
  }
}, { immediate: true })

const showMismatchBanner = computed(() =>
  props.windowMismatch && !mismatchDismissed.value && props.windowMismatchViews !== null,
)

/** 卡片当前有效计划窗口编码（旧卡按旧窗口反向推导） */
const effectiveEncoding = computed(() => {
  const { start, end } = effectivePlannedWindow(props.activeCard)
  return { start: formatPlannedPosition(start), end: formatPlannedPosition(end) }
})

const startEncoding = computed(() => props.draftPayoffStart ?? effectiveEncoding.value.start)
const endEncoding = computed(() => props.draftPayoffEnd ?? effectiveEncoding.value.end)
const startIsSet = computed(() => parsePlannedPosition(startEncoding.value)?.kind !== 'none')

const plantedAtValue = computed(() => props.draftPlantedAt ?? props.activeCard.plantedAt)
const relatedCharactersTextValue = computed(() =>
  props.draftRelatedCharactersText ?? props.activeCard.relatedCharacters.join('、'))
const relatedEntitiesTextValue = computed(() =>
  props.draftRelatedEntitiesText ?? props.activeCard.relatedEntities.join('、'))
const relatedChaptersValues = computed(() =>
  (props.draftRelatedChapters ?? props.activeCard.relatedChapters.join('\n'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== ''))
const resolvedAtValue = computed(() => props.draftResolvedAt ?? props.activeCard.resolvedAt ?? '')

const displayWindow = computed(() => {
  const start = parsePlannedPosition(startEncoding.value) as PlannedPosition | null
  const end = parsePlannedPosition(endEncoding.value) as PlannedWindowEnd | null
  return plannedWindowDisplay(start ?? { kind: 'none' }, end ?? { kind: 'none' })
})

/** 埋设章节是否为无法归类的兼容原文（有目录且既非真实引用也非章号形态） */
const plantedIsRaw = computed(() =>
  props.picker.catalogReady
  && plantedAtValue.value !== ''
  && !props.picker.catalog.entries.some((entry) => entry.ref === plantedAtValue.value)
  && /第\d+章/.exec(plantedAtValue.value) === null)

const plantedDisplay = computed(() => {
  if (plantedAtValue.value === '') {
    return '未填'
  }
  const described = describeChapterValue(props.picker.catalog, props.picker.catalogReady, plantedAtValue.value)
  return described.badge ? `${described.text}（${described.badge}）` : described.text
})

/** 实际回收章节的状态一致性（§三.3：不隐式清空，就地说明） */
const resolvedStatusHint = computed(() => {
  if (resolvedAtValue.value === '') {
    return ''
  }
  if (props.activeCard.status !== 'revealed' && props.activeCard.status !== 'resolved') {
    return props.activeCard.status === 'abandoned'
      ? '已放弃状态下保留的历史回收记录，可继续修订或清除。'
      : '当前状态不是已揭晓或已解决；本章仅作为事实记录保留。'
  }
  return ''
})

/** 实际回收章节指向的章节是否存在（历史不存在值只保留、提示或清除） */
const resolvedMissingHint = computed(() => {
  if (resolvedAtValue.value === '' || !props.picker.catalogReady) {
    return ''
  }
  const number = /第(\d+)章/.exec(resolvedAtValue.value)
  if (number === null) {
    return '该记录不是标准章节引用，按原文保留。'
  }
  return props.picker.catalog.entries.some((entry) => entry.number === Number(number[1]))
    ? ''
    : '该章号当前没有章节（原引用保留）。'
})

const abandonReasonInput = ref<HTMLTextAreaElement | null>(null)
const revisionInput = ref<HTMLTextAreaElement | null>(null)
// 进入操作态默认聚焦原因输入（计划 §四.1：输入框默认聚焦）。immediate 覆盖
// 「拖入已放弃列」路径——面板挂载时操作态已在，靠变更触发会漏掉这次聚焦
watch(
  () => props.abandonIntent,
  async (intent) => {
    if (intent !== null) {
      await nextTick()
      abandonReasonInput.value?.focus()
    }
  },
  { flush: 'post', immediate: true },
)
watch(
  () => props.reasonRevision,
  async (revision) => {
    if (revision !== null) {
      await nextTick()
      revisionInput.value?.focus()
    }
  },
  { flush: 'post', immediate: true },
)

/** 状态选择出口：「已放弃」拦截进原因操作态（已放弃卡再点可登记新原因），其余走两秒延迟保存 */
function onSelectStatus(status: ForeshadowingStatusView) {
  if (status === 'abandoned') {
    emit('startAbandon')
    return
  }
  emit('updateDraftStatus', status)
}

function onTitleInput(event: Event) {
  emit('updateDraftName', (event.target as HTMLInputElement).value)
}

function onReaderInput(event: Event) {
  emit('updateDraftReaderView', (event.target as HTMLTextAreaElement).value)
}

function onTruthInput(event: Event) {
  emit('updateDraftAuthorTruth', (event.target as HTMLTextAreaElement).value)
}

function onAbandonReasonInput(event: Event) {
  emit('updateAbandonReason', (event.target as HTMLTextAreaElement).value)
}

function onRevisionInput(event: Event) {
  emit('updateReasonRevision', (event.target as HTMLTextAreaElement).value)
}

function onCharactersInput(event: Event) {
  emit('updateDraftRelatedCharactersText', (event.target as HTMLInputElement).value)
}

function onEntitiesInput(event: Event) {
  emit('updateDraftRelatedEntitiesText', (event.target as HTMLInputElement).value)
}

/** 实际回收选择器的清除出口（清除事实记录，不动计划窗口或关联章节） */
function onResolvedPick(value: string | string[] | null) {
  emit('updateDraftResolvedAt', typeof value === 'string' ? value : '')
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
    save-testid="foreshadowing-detail-save-status"
    :conflict-expanded="conflict?.expanded === true"
    @close="emit('close')"
    @mode-change="emit('setDetailMode', $event)"
  >
    <template #title>
      <input
        type="text"
        class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
        placeholder="伏笔名"
        data-testid="foreshadowing-detail-title"
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
        testid-prefix="foreshadowing"
        @expand="emit('expandConflict')"
      />
      <CardSaveFailure
        v-if="savePhase === 'failed'"
        testid-prefix="foreshadowing"
        :message="actionError"
        @retry="emit('retrySave')"
      />
      <p v-else-if="actionError" class="mb-3 shrink-0 text-xs text-red-600">{{ actionError }}</p>
    </template>

    <!-- 工具区：状态列按钮（守护时冻结） -->
    <template #tools>
      <CardStatusTools
        v-if="!guard"
        :columns="statusButtons"
        :active-column-key="activeCard.status"
        :pending-column-key="draftStatus"
        @select="(columnKey) => onSelectStatus(columnKey as ForeshadowingStatusView)"
      />
    </template>

    <!-- 主内容：高级信息（默认折叠） + 放弃操作态 / 双正文 -->
    <template #content>
      <!-- 高级信息（阶段 2）：折叠只是界面状态不产生保存；与正文共用滚动责任 -->
      <section
        v-if="!abandonIntent"
        class="mb-2 shrink-0 rounded-md border border-gray-200 bg-gray-50 text-xs"
        data-testid="foreshadowing-detail-advanced"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between px-3 py-2 text-left text-gray-600 transition-colors hover:bg-gray-100"
          data-testid="foreshadowing-detail-advanced-toggle"
          @click="advancedOpen = !advancedOpen"
        >
          <span>高级信息</span>
          <span class="text-gray-400">{{ advancedOpen ? '收起 ▴' : '埋设章节、回收窗口、关联信息等 ▾' }}</span>
        </button>

        <div v-if="advancedOpen" class="border-t border-gray-200 px-3 py-2">
          <!-- 窗口两套数据不一致（§八.1）：并列展示 + 三个固定出口，系统不自动挑一套 -->
          <div
            v-if="showMismatchBanner"
            class="mb-2 rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-2"
            data-testid="foreshadowing-detail-window-mismatch"
          >
            <p class="font-medium text-amber-800">回收窗口的两份数据不一致（外部修改所致）</p>
            <p class="mt-1 text-amber-700">结构化窗口：{{ windowMismatchViews?.structured }}</p>
            <p class="text-amber-700">兼容窗口（旧字段）：{{ windowMismatchViews?.legacy }}</p>
            <p class="mt-1 text-[11px] leading-4 text-amber-600">
              采用兼容窗口会把它解释为固定章号位置或开放终点并重写结构化数据，原有的相对位置记录不保留；返回则保留两套数据与当前输入。
            </p>
            <div class="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                class="rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canAdoptWindow"
                :title="canAdoptWindow ? undefined : '等本卡片未落盘内容收口后可选择'"
                data-testid="foreshadowing-detail-mismatch-structured"
                @click="emit('adoptStructuredWindow')"
              >
                采用结构化窗口
              </button>
              <button
                type="button"
                class="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canAdoptWindow"
                :title="canAdoptWindow ? undefined : '等本卡片未落盘内容收口后可选择'"
                data-testid="foreshadowing-detail-mismatch-legacy"
                @click="emit('adoptLegacyWindow')"
              >
                采用兼容窗口
              </button>
              <button
                type="button"
                class="rounded-md px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100"
                data-testid="foreshadowing-detail-mismatch-back"
                @click="mismatchDismissed = true"
              >
                返回
              </button>
            </div>
          </div>

          <!-- 章节已创建、卡片引用尚未保存（§三.4 第 4 条） -->
          <p
            v-if="chapterCreateNotice"
            class="mb-2 rounded-md border border-blue-200 bg-blue-50/60 px-2.5 py-1.5 text-[11px] text-blue-700"
            data-testid="foreshadowing-detail-chapter-created-notice"
          >
            {{ chapterCreateNotice }}
          </p>

          <!-- 预览模式：已有值与明确的「未设置」；编辑模式：控件 -->
          <template v-if="detailMode === 'edit' && guard === null">
            <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
              <label class="self-start pt-1 text-gray-500">埋设章节</label>
              <div>
                <p v-if="plantedIsRaw" class="mb-1 rounded bg-amber-50 px-1.5 py-px text-[11px] text-amber-700">
                  兼容原文：「{{ plantedAtValue }}」——改为真实章节或新建后保存才会更新为章节引用。
                </p>
                <ChapterPicker
                  :model-value="plantedAtValue === '' || plantedIsRaw ? null : plantedAtValue"
                  :entries="picker.catalog.entries"
                  :catalog-ready="picker.catalogReady"
                  :loading="picker.loading"
                  :load-error="picker.loadError"
                  allow-create
                  :suggested-number="picker.suggestedNumber"
                  :session-key="`${picker.sessionKey}:planted`"
                  :create-handler="picker.createHandler"
                  placeholder="搜索并选择埋设章节（必填）…"
                  @update:model-value="(value) => typeof value === 'string' && emit('updateDraftPlantedAt', value)"
                  @retry-load="emit('retryChapterLoad')"
                />
              </div>

              <label class="self-start pt-1 text-gray-500">回收窗口</label>
              <div class="space-y-1.5">
                <PlannedPositionPicker
                  :model-value="startEncoding"
                  :entries="picker.catalog.entries"
                  :catalog-ready="picker.catalogReady"
                  :loading="picker.loading"
                  :load-error="picker.loadError"
                  allow-create
                  :suggested-number="picker.suggestedNumber"
                  :session-key="`${picker.sessionKey}:start`"
                  :create-handler="picker.createHandler"
                  :latest-chapter-number="picker.latestChapterNumber"
                  @update:model-value="(value) => emit('updateDraftPayoffStart', value)"
                />
                <PlannedPositionPicker
                  :model-value="endEncoding"
                  :entries="picker.catalog.entries"
                  :catalog-ready="picker.catalogReady"
                  :loading="picker.loading"
                  :load-error="picker.loadError"
                  allow-create
                  :suggested-number="picker.suggestedNumber"
                  :session-key="`${picker.sessionKey}:end`"
                  :create-handler="picker.createHandler"
                  :latest-chapter-number="picker.latestChapterNumber"
                  allow-open
                  :disabled="!startIsSet"
                  @update:model-value="(value) => emit('updateDraftPayoffEnd', value)"
                />
                <p v-if="!startIsSet" class="text-[11px] text-gray-400">起点未设置时终点一并未设置；先补起点再配终点。</p>
              </div>

              <label class="self-start pt-1 text-gray-500">关联角色</label>
              <input
                type="text"
                class="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                placeholder="顿号或逗号分隔多项，可留空；保存时去空白去重"
                data-testid="foreshadowing-detail-related-characters"
                :value="relatedCharactersTextValue"
                @input="onCharactersInput"
              >

              <label class="self-start pt-1 text-gray-500">关联物品</label>
              <input
                type="text"
                class="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                placeholder="顿号或逗号分隔多项，可留空；保存时去空白去重"
                data-testid="foreshadowing-detail-related-entities"
                :value="relatedEntitiesTextValue"
                @input="onEntitiesInput"
              >

              <label class="self-start pt-1 text-gray-500">暗示历史</label>
              <ChapterPicker
                multiple
                :model-value="relatedChaptersValues"
                :entries="picker.catalog.entries"
                :catalog-ready="picker.catalogReady"
                :loading="picker.loading"
                :load-error="picker.loadError"
                allow-create
                :suggested-number="picker.suggestedNumber"
                :session-key="`${picker.sessionKey}:related`"
                :create-handler="picker.createHandler"
                placeholder="搜索并添加关联章节（顺序即排列）…"
                @update:model-value="(value) => Array.isArray(value) && emit('updateDraftRelatedChapters', value)"
                @retry-load="emit('retryChapterLoad')"
              />

              <label class="self-start pt-1 text-gray-500">红鲱鱼</label>
              <label class="flex items-center gap-1.5 text-gray-700">
                <input
                  type="checkbox"
                  class="size-3.5 accent-gray-800"
                  data-testid="foreshadowing-detail-red-herring"
                  :checked="draftIsRedHerring ?? activeCard.isRedHerring"
                  @change="emit('updateDraftIsRedHerring', ($event.target as HTMLInputElement).checked)"
                >
                故意误导读者（红鲱鱼）
              </label>

              <label class="self-start pt-1 text-gray-500">实际回收</label>
              <div>
                <ChapterPicker
                  :model-value="resolvedAtValue === '' ? null : resolvedAtValue"
                  :entries="picker.catalog.entries"
                  :catalog-ready="picker.catalogReady"
                  :loading="picker.loading"
                  :load-error="picker.loadError"
                  clearable
                  :suggested-number="picker.suggestedNumber"
                  :session-key="`${picker.sessionKey}:resolved`"
                  :create-handler="null"
                  placeholder="从已有章节选择（不提供新建）…"
                  @update:model-value="onResolvedPick"
                  @retry-load="emit('retryChapterLoad')"
                />
                <p v-if="resolvedStatusHint" class="mt-1 text-[11px] text-amber-600">{{ resolvedStatusHint }}</p>
                <p v-if="resolvedMissingHint" class="mt-1 text-[11px] text-amber-600">{{ resolvedMissingHint }}</p>
              </div>

              <!-- 已有放弃原因：只读展示 + 「修订原因」明确操作（§三.1） -->
              <template v-if="activeCard.status === 'abandoned'">
                <label class="self-start pt-1 text-amber-600">放弃原因</label>
                <div>
                  <p class="rounded bg-amber-50 px-1.5 py-px font-medium text-amber-800">{{ activeCard.abandonedReason || '（未登记）' }}</p>
                  <!-- 修订操作态：原位输入，应用携带最新版本立即保存；取消不写入 -->
                  <div
                    v-if="reasonRevision"
                    class="mt-1.5 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5"
                    data-testid="foreshadowing-detail-revision"
                  >
                    <textarea
                      ref="revisionInput"
                      :value="reasonRevision.reason"
                      class="min-h-16 w-full resize-none rounded-md border border-amber-200 bg-white px-2 py-1 text-xs leading-relaxed text-gray-800 placeholder-amber-300 focus:border-amber-500 focus:outline-none"
                      placeholder="修订这段历史说明（已放弃状态下不能为空）。"
                      data-testid="foreshadowing-detail-revision-reason"
                      @input="onRevisionInput"
                    />
                    <div class="mt-1 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        class="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-100"
                        data-testid="foreshadowing-detail-revision-cancel"
                        @click="emit('cancelReasonRevision')"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        class="rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                        :disabled="!reasonRevision.reason.trim() || !canConfirmReasonRevision || isConfirmingReasonRevision"
                        :title="canConfirmReasonRevision || !reasonRevision.reason.trim() ? undefined : '等本卡片未落盘内容收口后可应用'"
                        data-testid="foreshadowing-detail-revision-confirm"
                        @click="emit('confirmReasonRevision')"
                      >
                        {{ isConfirmingReasonRevision ? '正在应用…' : '应用修订' }}
                      </button>
                    </div>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="mt-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:bg-gray-100"
                    data-testid="foreshadowing-detail-revision-start"
                    @click="emit('startReasonRevision')"
                  >
                    修订原因
                  </button>
                </div>
              </template>
            </div>
          </template>

          <template v-else>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt class="text-gray-500">埋设章节</dt>
              <dd class="text-gray-800">{{ plantedDisplay }}</dd>
              <dt class="text-gray-500">回收窗口</dt>
              <dd class="text-gray-800">{{ displayWindow }}</dd>
              <dt class="text-gray-500">关联角色</dt>
              <dd class="text-gray-800">{{ relatedCharactersTextValue || '未填' }}</dd>
              <dt class="text-gray-500">关联物品</dt>
              <dd class="text-gray-800">{{ relatedEntitiesTextValue || '未填' }}</dd>
              <dt class="text-gray-500">暗示历史</dt>
              <dd class="text-gray-800">{{ relatedChaptersValues.join('、') || '未填' }}</dd>
              <dt class="text-gray-500">红鲱鱼</dt>
              <dd class="text-gray-800">{{ (draftIsRedHerring ?? activeCard.isRedHerring) ? '是（故意误导读者）' : '否' }}</dd>
              <dt class="text-gray-500">实际回收</dt>
              <dd class="text-gray-800">
                {{ resolvedAtValue || '未登记' }}
                <span v-if="resolvedStatusHint" class="ml-1 text-amber-600">{{ resolvedStatusHint }}</span>
                <span v-if="resolvedMissingHint" class="ml-1 text-amber-600">{{ resolvedMissingHint }}</span>
              </dd>
              <template v-if="activeCard.status === 'abandoned'">
                <dt class="text-amber-600">放弃原因</dt>
                <dd class="rounded bg-amber-50 px-1.5 py-px font-medium text-amber-800">
                  {{ activeCard.abandonedReason || '（未登记）' }}
                </dd>
              </template>
            </dl>
          </template>
        </div>
      </section>

      <!-- 放弃操作态（阶段 4）：正文双区原位收起，原因登记 + 明确确认，不产生两秒计时器 -->
      <div
        v-if="abandonIntent"
        class="flex min-h-0 flex-1 flex-col rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5"
        data-testid="foreshadowing-detail-abandon"
      >
        <p class="shrink-0 text-sm font-medium text-amber-800">为什么不再回收这条伏笔？</p>
        <p class="mt-0.5 shrink-0 text-[11px] leading-4 text-amber-600">记录创作决策，避免以后误以为漏写。</p>
        <textarea
          ref="abandonReasonInput"
          :value="abandonIntent.reason"
          class="mt-2 min-h-0 w-full flex-1 resize-none rounded-md border border-amber-200 bg-white px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          placeholder="例如：这条线索已被第三章的直接说明取代，继续回收会让节奏拖沓。"
          data-testid="foreshadowing-detail-abandon-reason"
          @input="onAbandonReasonInput"
        />
        <div class="mt-2 flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100"
            data-testid="foreshadowing-detail-abandon-cancel"
            @click="emit('cancelAbandon')"
          >
            取消
          </button>
          <button
            type="button"
            class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!abandonIntent.reason.trim() || !canConfirmAbandon || isConfirmingAbandon"
            :title="canConfirmAbandon || !abandonIntent.reason.trim() ? undefined : '等本卡片未落盘内容收口后可确认'"
            data-testid="foreshadowing-detail-abandon-confirm"
            @click="emit('confirmAbandon')"
          >
            {{ isConfirmingAbandon ? '正在放弃…' : '确认放弃' }}
          </button>
        </div>
      </div>

      <!-- 读者视角：写正文章节时读者已知的事实（操作态收起） -->
      <div v-if="!abandonIntent" class="mt-2 flex min-h-16 flex-1 basis-1/2 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-gray-500">读者视角（当时可见事实）</p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          class="flex-1"
          data-testid="foreshadowing-detail-reader"
          @dblclick="onBodyDblClick"
        >
          <!-- 纯文本预览：正文两节是 textarea 自由文本而非 markdown 源（同节奏意图修复） -->
          <div
            v-if="readerValue"
            class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
          >{{ readerValue }}</div>
          <p v-else class="text-sm text-gray-400">双击或点击「编辑」补写读者当时看到的事实。</p>
        </PlainBodySurface>
        <PlainBodySurface v-else variant="edit" class="flex-1">
          <textarea
            :value="draftReaderView ?? activeCard.readerBody"
            :readonly="guard !== null"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="埋设当时读者能看到的事实（不含剧透）。"
            data-testid="foreshadowing-detail-reader-input"
            @input="onReaderInput"
          />
        </PlainBodySurface>
      </div>

      <!-- 作者真相：剧透区，UI 是作者界面直接展示（§七），AI 工具链路才有遮蔽（操作态收起） -->
      <div v-if="!abandonIntent" class="mt-2 flex min-h-16 flex-1 basis-1/2 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-amber-600">
          作者视角（真相 / 剧透）
        </p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          tone="warning"
          class="flex-1"
          data-testid="foreshadowing-detail-truth"
          @dblclick="onBodyDblClick"
        >
          <div
            v-if="truthValue"
            class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800"
          >{{ truthValue }}</div>
          <p v-else class="text-sm text-amber-500">这条伏笔还没登记真相（可后补）。</p>
        </PlainBodySurface>
        <PlainBodySurface v-else variant="edit" tone="warning" class="flex-1">
          <textarea
            :value="draftAuthorTruth ?? activeCard.authorTruth"
            :readonly="guard !== null"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            placeholder="作者知道的真相——回收时的钥匙。"
            data-testid="foreshadowing-detail-truth-input"
            @input="onTruthInput"
          />
        </PlainBodySurface>
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
