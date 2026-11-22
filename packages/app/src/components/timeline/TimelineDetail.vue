<script setup lang="ts">
/**
 * 事件详情区（时间线 JSON 化施工计划 §9.4）：右侧内嵌面板，三个形态——
 * - 新建事件表单（点/区间 + 标题 + 摘要；落位默认尾部，界面暂不提供调整顺序，交 AI 移动）；
 * - 编辑中的事件（save-session 会话：两秒自动保存、状态灯、失败重试、
 *   冲突冻结 + 四出口：采用磁盘 / 采用我的 / 返回编辑 / 重新读取）；
 * - 空态（引导点击标记或新建）。
 *
 * 表单字段直写草稿（store 做 diff 补丁保存）：标题/摘要/明确时间/相对时间/
 * 参与者（四类要素 + 角色）/情节/关联章节（ChapterPicker 添加器 + 叙述方式）/
 * 因果前驱。删除带两击确认。
 */
import { computed, ref } from 'vue'

import type { TimelineElementOptionView } from '@novai/core/services/timeline-service'
import type { ChapterCatalogEntry } from '@novai/core/types/chapters'
import type { NarrativeMode, TimelineChapterRef } from '@novai/core/types/timeline'
import type { SaveSessionPhase } from '../../composables/save-session'
import type { DetailSavePhase } from '../layout/detail-save-phase'
import { TIMELINE_PARTICIPANT_TYPES } from '@novai/core/types/timeline'
import SaveStatusLight from '../layout/SaveStatusLight.vue'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import { useChapterCatalog } from '../../composables/chapter-catalog'
import { narrativeModeLabel, useTimelineStore } from '../../stores/timeline'
import { elementRefKey } from '../../utils/element-ref-key'

const store = useTimelineStore()
const catalog = useChapterCatalog()

const session = computed(() => store.detailSession)
const draft = computed(() => session.value?.draft ?? null)

function toLightPhase(phase: SaveSessionPhase): DetailSavePhase {
  if (phase === 'conflict') return 'conflict'
  if (phase === 'saving') return 'saving'
  if (phase === 'failed') return 'failed'
  if (phase === 'clean') return 'clean'
  return 'pending'
}

const lightPhase = computed(() => toLightPhase(store.detailPhase(session.value)))

/** 编辑输入（store 内部 diff 出补丁，只提交变化字段） */
function patch(fields: Record<string, unknown>) {
  if (store.selectedEventId) {
    store.setDetailDraft(store.selectedEventId, fields)
  }
}

/* ---------- 明确时间 ---------- */

const storyTimeEnabled = computed(() => draft.value?.storyTime !== null)

function toggleStoryTime(enabled: boolean) {
  patch({ storyTime: enabled ? { year: 1 } : null })
}

function patchStoryTime(fields: Partial<NonNullable<typeof draft.value>['storyTime']>) {
  const current = draft.value?.storyTime
  if (!current) {
    return
  }
  patch({ storyTime: { ...current, ...fields } })
}

/* ---------- 相对时间 ---------- */

const relativeTimeEnabled = computed(() => draft.value?.relativeTime !== null)

function toggleRelativeTime(enabled: boolean) {
  patch({
    relativeTime: enabled
      ? { anchorEventId: store.anchorEventOptions[0]?.eventId ?? '', offset: 1, unit: '天', direction: 'after' as const }
      : null,
  })
}

function patchRelativeTime(fields: Partial<NonNullable<typeof draft.value>['relativeTime']>) {
  const current = draft.value?.relativeTime
  if (!current) {
    return
  }
  patch({ relativeTime: { ...current, ...fields } })
}

/** 锚事件展示名（当前账本解析；已删除的锚回退标识） */
function eventTitleOf(eventId: string): string {
  const option = store.anchorEventOptions.find((item) => item.eventId === eventId)
  if (option) {
    return option.title
  }
  const self = store.markers.find((item) => item.marker.kind !== 'end' && item.marker.eventId === eventId)
  return self && self.marker.kind !== 'end' ? self.marker.event.title : `${eventId}（已删除）`
}

/* ---------- 参与者与情节（内联搜索添加器） ---------- */

const participantQuery = ref('')
const participantOptions = ref<TimelineElementOptionView[]>([])
const participantOpen = ref(false)
let participantToken = 0

async function searchParticipants(value: string) {
  const token = ++participantToken
  const text = value.trim()
  if (!text) {
    participantOptions.value = []
    return
  }
  const result = await store.searchElementOptions(text)
  if (token === participantToken) {
    participantOptions.value = result.filter(
      (option) => TIMELINE_PARTICIPANT_TYPES.includes(option.type) && !(draft.value?.participants ?? []).some((entry) => entry.id === elementRefKey(option)),
    )
    participantOpen.value = true
  }
}

function addParticipant(option: TimelineElementOptionView) {
  store.rememberOption(option)
  patch({ participants: [...(draft.value?.participants ?? []), { kind: 'element' as const, id: elementRefKey(option) }] })
  participantQuery.value = ''
  participantOptions.value = []
  participantOpen.value = false
}

function removeParticipant(id: string) {
  patch({ participants: (draft.value?.participants ?? []).filter((entry) => entry.id !== id) })
}

function setParticipantRole(id: string, role: string) {
  patch({
    participants: (draft.value?.participants ?? []).map((entry) => (entry.id === id ? { ...entry, role: role || undefined } : entry)),
  })
}

const plotQuery = ref('')
const plotOptions = ref<TimelineElementOptionView[]>([])
const plotOpen = ref(false)
let plotToken = 0

async function searchPlots(value: string) {
  const token = ++plotToken
  const text = value.trim()
  if (!text) {
    plotOptions.value = []
    return
  }
  const result = await store.searchElementOptions(text, 'plot')
  if (token === plotToken) {
    plotOptions.value = result.filter((option) => !(draft.value?.plotIds ?? []).includes(elementRefKey(option)))
    plotOpen.value = true
  }
}

function addPlot(option: TimelineElementOptionView) {
  store.rememberOption(option)
  patch({ plotIds: [...(draft.value?.plotIds ?? []), elementRefKey(option)] })
  plotQuery.value = ''
  plotOptions.value = []
  plotOpen.value = false
}

function removePlot(id: string) {
  patch({ plotIds: (draft.value?.plotIds ?? []).filter((entry) => entry !== id) })
}

function onPickerBlur(close: () => void) {
  setTimeout(close, 150)
}

/* ---------- 关联章节（ChapterPicker 添加器 + 行内叙述方式） ---------- */

const chapters = computed<TimelineChapterRef[]>(() => draft.value?.chapters ?? [])

/** 章节号 → 目录条目（重号取第一个展示；缺失返回 null） */
function chapterEntryOf(chapterNumber: number): ChapterCatalogEntry | null {
  return catalog.entries.value.find((entry) => entry.number === chapterNumber) ?? null
}

function isAmbiguousChapter(chapterNumber: number): boolean {
  return catalog.entries.value.filter((entry) => entry.number === chapterNumber).length > 1
}

/** 添加器：ChapterPicker 以 ref 为值，这里换算成章号并按章号去重 */
function onAddChapters(refs: string | string[] | null) {
  const added = Array.isArray(refs) ? refs : refs ? [refs] : []
  const existing = new Set(chapters.value.map((ref) => ref.chapterNumber))
  const next = [...chapters.value]
  for (const ref of added) {
    const entry = catalog.entries.value.find((item) => item.ref === ref)
    if (entry && !existing.has(entry.number)) {
      existing.add(entry.number)
      next.push({ chapterNumber: entry.number, mode: 'current' })
    }
  }
  patch({ chapters: next })
}

function setChapterMode(chapterNumber: number, mode: NarrativeMode) {
  patch({ chapters: chapters.value.map((ref) => (ref.chapterNumber === chapterNumber ? { ...ref, mode } : ref)) })
}

function removeChapter(chapterNumber: number) {
  patch({ chapters: chapters.value.filter((ref) => ref.chapterNumber !== chapterNumber) })
}

/* ---------- 因果前驱 ---------- */

const causedByOpen = ref(false)

const causedByCandidates = computed(() =>
  store.anchorEventOptions.filter((item) => !(draft.value?.causedBy ?? []).includes(item.eventId)),
)

function addCausedBy(eventId: string) {
  causedByOpen.value = false
  if (eventId) {
    patch({ causedBy: [...(draft.value?.causedBy ?? []), eventId] })
  }
}

function removeCausedBy(eventId: string) {
  patch({ causedBy: (draft.value?.causedBy ?? []).filter((entry) => entry !== eventId) })
}

/* ---------- 冲突出口 ---------- */

const confirmAdopt = ref<'disk' | 'mine' | null>(null)
const busy = ref(false)

async function adoptDisk() {
  if (confirmAdopt.value !== 'disk') {
    confirmAdopt.value = 'disk'
    return
  }
  confirmAdopt.value = null
  busy.value = true
  try {
    await store.adoptDiskVersion()
  } finally {
    busy.value = false
  }
}

async function adoptMine() {
  if (confirmAdopt.value !== 'mine') {
    confirmAdopt.value = 'mine'
    return
  }
  confirmAdopt.value = null
  busy.value = true
  try {
    await store.overwriteWithMine()
  } finally {
    busy.value = false
  }
}

/* ---------- 删除（两击确认） ---------- */

const confirmDelete = ref(false)

async function removeEvent() {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    return
  }
  confirmDelete.value = false
  await store.removeEvent(store.selectedEventId)
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="事件详情">
    <!-- 新建表单 -->
    <div v-if="store.createOpen" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <h3 class="text-sm font-semibold text-gray-900">新建事件</h3>
      <div class="flex gap-2 text-xs text-gray-500">
        <button
          v-for="kind in (['point', 'span'] as const)"
          :key="kind"
          type="button"
          :class="[
            'flex-1 rounded-lg border px-2 py-1.5 transition-colors',
            store.createDraft.kind === kind ? 'border-indigo-400 bg-indigo-50 font-medium text-indigo-700' : 'border-gray-300 hover:bg-gray-50',
          ]"
          @click="store.createDraft.kind = kind"
        >
          {{ kind === 'point' ? '点事件（占一个时刻）' : '区间事件（起止两端）' }}
        </button>
      </div>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        标题
        <input
          v-model="store.createDraft.title"
          type="text"
          maxlength="40"
          placeholder="如：北境之战爆发"
          class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
        >
      </label>
      <!-- 明确时间：建议填写（时间轴表头按它显示）；年份留空 = 不填日期 -->
      <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5" data-testid="timeline-create-date">
        <legend class="px-1 text-xs text-gray-500">日期（建议填写，时间轴表头按它显示；年份留空 = 不填）</legend>
        <div class="grid grid-cols-2 gap-2 text-xs text-gray-500">
          <label class="flex flex-col gap-1">
            历法
            <input v-model="store.createDraft.calendar" type="text" maxlength="20" placeholder="苍穹历" class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500">
          </label>
          <label class="flex flex-col gap-1">
            年（可为负）
            <input
              v-model="store.createDraft.year"
              type="number"
              :placeholder="store.lastStoryTime ? `上一条：${store.lastStoryTime.year}` : '如 320'"
              class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
            >
          </label>
          <label class="flex flex-col gap-1">
            季节
            <input v-model="store.createDraft.season" type="text" maxlength="6" placeholder="春" class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500">
          </label>
          <label class="flex flex-col gap-1">
            月
            <input v-model="store.createDraft.month" type="number" min="1" max="12" class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500">
          </label>
          <label class="col-span-2 flex flex-col gap-1">
            日
            <input v-model="store.createDraft.day" type="number" min="1" max="31" class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500">
          </label>
        </div>
      </fieldset>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        摘要（可选，其余字段建好后在详情里补）
        <textarea
          v-model="store.createDraft.summary"
          rows="3"
          class="resize-none rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
        />
      </label>
      <p v-if="store.actionError" role="alert" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{{ store.actionError }}</p>
      <p class="text-[11px] text-gray-400">新事件落在时间轴末尾；需要调整先后顺序时，可以让 AI 帮你移动。</p>
      <div class="mt-auto flex gap-2">
        <button
          type="button"
          :disabled="store.createBusy"
          class="flex-1 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
          @click="store.submitCreate()"
        >
          {{ store.createBusy ? '创建中…' : '创建事件' }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-50"
          @click="store.createOpen = false"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 编辑中的事件 -->
    <div v-else-if="session && draft" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
        <span class="truncate text-xs text-gray-400">
          {{ store.selectedEventId }}
          <span v-if="store.selectedMarkerView?.marker.kind === 'start'" class="ml-1 text-indigo-500">区间事件</span>
        </span>
        <SaveStatusLight :phase="lightPhase" />
      </header>

      <div class="flex flex-col gap-4 p-4">
        <!-- 冲突冻结：四出口 -->
        <div
          v-if="session.conflict"
          role="alert"
          class="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-800"
        >
          <p class="font-medium">检测到外部修改（AI 或其他窗口改了这条事件），自动保存已冻结。</p>
          <p v-if="session.conflict.probing">正在读取磁盘最新版本…</p>
          <p v-else-if="session.conflict.missing">这条事件已在磁盘上不存在（可能已被删除）。</p>
          <p v-else-if="session.conflict.unreadable">读取磁盘版本失败：{{ session.conflict.unreadable }}</p>
          <div v-if="session.conflict.expanded && session.conflict.disk" class="rounded-md bg-white/70 px-2.5 py-2">
            <p class="mb-1 font-medium text-gray-700">磁盘最新版本</p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-gray-600">
              <dt>标题</dt><dd>{{ (session.conflict.disk as { event: { title: string } }).event.title }}</dd>
              <dt>摘要</dt><dd class="whitespace-pre-wrap">{{ (session.conflict.disk as { event: { summary: string } }).event.summary || '（未填）' }}</dd>
            </dl>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="!session.conflict.expanded"
              type="button"
              class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100"
              @click="store.refreshConflict()"
            >
              展开比较
            </button>
            <template v-else>
              <button
                type="button"
                :disabled="busy || session.conflict.probing || session.conflict.missing"
                class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                @click="adoptDisk"
              >
                {{ confirmAdopt === 'disk' ? '再点一次确认放弃本地' : '采用磁盘版本' }}
              </button>
              <button
                type="button"
                :disabled="busy"
                class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                @click="adoptMine"
              >
                {{ confirmAdopt === 'mine' ? '再点一次确认覆盖' : '采用我的当前内容' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-gray-600 transition-colors hover:bg-gray-50"
                @click="store.collapseConflict()"
              >
                返回继续编辑
              </button>
              <button
                type="button"
                class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-gray-600 transition-colors hover:bg-gray-50"
                @click="store.refreshConflict()"
              >
                重新读取
              </button>
            </template>
          </div>
        </div>

        <!-- 普通失败：原因 + 重试 -->
        <div
          v-if="session.failure"
          role="alert"
          class="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span class="min-w-0">{{ session.failure.message }}</span>
          <button type="button" class="shrink-0 rounded-md border border-red-300 px-2 py-0.5 transition-colors hover:bg-red-100" @click="store.retryDetailSave()">
            重试
          </button>
        </div>

        <label class="flex flex-col gap-1 text-xs text-gray-500">
          标题
          <input
            :value="draft.title"
            type="text"
            maxlength="40"
            class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
            @input="patch({ title: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label class="flex flex-col gap-1 text-xs text-gray-500">
          摘要
          <textarea
            :value="draft.summary"
            rows="4"
            placeholder="事件的自然语言描述…"
            class="resize-none rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
            @input="patch({ summary: ($event.target as HTMLTextAreaElement).value })"
          />
        </label>

        <!-- 明确时间（历法自由文本 + 数值段；null = 纯顺序时间） -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">
            <label class="flex items-center gap-1.5">
              <input type="checkbox" :checked="storyTimeEnabled" @change="toggleStoryTime(($event.target as HTMLInputElement).checked)">
              明确时间（历法纪年；不填 = 只按顺序排）
            </label>
          </legend>
          <div v-if="draft.storyTime" class="grid grid-cols-2 gap-2 text-xs text-gray-500">
            <label class="flex flex-col gap-1">
              历法（可选）
              <input
                :value="draft.storyTime.calendar ?? ''"
                type="text"
                maxlength="20"
                placeholder="苍穹历"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchStoryTime({ calendar: ($event.target as HTMLInputElement).value || undefined })"
              >
            </label>
            <label class="flex flex-col gap-1">
              年（必填，可为负）
              <input
                :value="draft.storyTime.year"
                type="number"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchStoryTime({ year: Number(($event.target as HTMLInputElement).value) || 0 })"
              >
            </label>
            <label class="flex flex-col gap-1">
              季节（可选）
              <input
                :value="draft.storyTime.season ?? ''"
                type="text"
                maxlength="6"
                placeholder="春"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchStoryTime({ season: ($event.target as HTMLInputElement).value || undefined })"
              >
            </label>
            <label class="flex flex-col gap-1">
              月（可选）
              <input
                :value="draft.storyTime.month ?? ''"
                type="number"
                min="1"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchStoryTime({ month: Number(($event.target as HTMLInputElement).value) || undefined })"
              >
            </label>
            <label class="col-span-2 flex flex-col gap-1">
              日（可选）
              <input
                :value="draft.storyTime.day ?? ''"
                type="number"
                min="1"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchStoryTime({ day: Number(($event.target as HTMLInputElement).value) || undefined })"
              >
            </label>
          </div>
          <p v-else class="text-[11px] text-gray-400">建议填写：时间轴表头按明确时间显示日期，不填只剩列表顺序，事件多了难以分辨发生在何时。</p>
        </fieldset>

        <!-- 相对时间（锚事件 + 偏移；锚链画在轴下） -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">
            <label class="flex items-center gap-1.5">
              <input type="checkbox" :checked="relativeTimeEnabled" @change="toggleRelativeTime(($event.target as HTMLInputElement).checked)">
              相对时间（锚事件 + 偏移）
            </label>
          </legend>
          <div v-if="draft.relativeTime" class="grid grid-cols-2 gap-2 text-xs text-gray-500">
            <label class="col-span-2 flex flex-col gap-1">
              锚事件
              <select
                :value="draft.relativeTime.anchorEventId"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @change="patchRelativeTime({ anchorEventId: ($event.target as HTMLSelectElement).value })"
              >
                <option value="" disabled>选择锚事件…</option>
                <option v-for="option in store.anchorEventOptions" :key="option.eventId" :value="option.eventId">{{ option.title }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              方向
              <select
                :value="draft.relativeTime.direction"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @change="patchRelativeTime({ direction: ($event.target as HTMLSelectElement).value as 'before' | 'after' })"
              >
                <option value="after">之后</option>
                <option value="before">之前</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              偏移量
              <input
                :value="draft.relativeTime.offset"
                type="number"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchRelativeTime({ offset: Number(($event.target as HTMLInputElement).value) || 0 })"
              >
            </label>
            <label class="col-span-2 flex flex-col gap-1">
              单位（天 / 月 / 年 / 纪等开放短词）
              <input
                :value="draft.relativeTime.unit"
                type="text"
                maxlength="10"
                class="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 outline-none focus:border-gray-500"
                @input="patchRelativeTime({ unit: ($event.target as HTMLInputElement).value })"
              >
            </label>
          </div>
        </fieldset>

        <!-- 参与者（四类要素 + 角色） -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">参与要素（人物 / 地点 / 实体 / 世界观）</legend>
          <div class="relative">
            <input
              v-model="participantQuery"
              type="text"
              placeholder="搜索要素名称添加…"
              class="w-full rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
              @input="searchParticipants(participantQuery)"
              @focus="participantOptions.length > 0 && (participantOpen = true)"
              @blur="onPickerBlur(() => (participantOpen = false))"
            >
            <ul
              v-if="participantOpen && participantOptions.length > 0"
              class="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            >
              <li v-for="option in participantOptions" :key="elementRefKey(option)">
                <button
                  type="button"
                  class="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
                  @mousedown.prevent="addParticipant(option)"
                >
                  <span class="text-sm text-gray-800">{{ option.name }} <span class="ml-1 text-xs text-gray-400">{{ option.type }}</span></span>
                  <span v-if="option.summary" class="w-full truncate text-xs text-gray-400">{{ option.summary }}</span>
                </button>
              </li>
            </ul>
          </div>
          <ul v-if="draft.participants.length > 0" class="flex flex-col gap-1.5">
            <li v-for="participant in draft.participants" :key="participant.id" class="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5">
              <span class="min-w-0 flex-1 truncate text-xs text-gray-800">{{ store.elementLabelOf(participant.id) }}</span>
              <input
                :value="participant.role ?? ''"
                type="text"
                maxlength="20"
                placeholder="角色（如 主帅）"
                class="w-24 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 outline-none focus:border-gray-400"
                @input="setParticipantRole(participant.id, ($event.target as HTMLInputElement).value)"
              >
              <button type="button" aria-label="移除参与者" class="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600" @click="removeParticipant(participant.id)">×</button>
            </li>
          </ul>
        </fieldset>

        <!-- 情节 -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">关联情节（可多段）</legend>
          <div class="relative">
            <input
              v-model="plotQuery"
              type="text"
              placeholder="搜索情节名称添加…"
              class="w-full rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
              @input="searchPlots(plotQuery)"
              @focus="plotOptions.length > 0 && (plotOpen = true)"
              @blur="onPickerBlur(() => (plotOpen = false))"
            >
            <ul
              v-if="plotOpen && plotOptions.length > 0"
              class="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            >
              <li v-for="option in plotOptions" :key="elementRefKey(option)">
                <button
                  type="button"
                  class="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
                  @mousedown.prevent="addPlot(option)"
                >
                  <span class="text-sm text-gray-800">{{ option.name }}</span>
                  <span v-if="option.summary" class="w-full truncate text-xs text-gray-400">{{ option.summary }}</span>
                </button>
              </li>
            </ul>
          </div>
          <ul v-if="draft.plotIds.length > 0" class="flex flex-wrap gap-1.5">
            <li
              v-for="plotId in draft.plotIds"
              :key="plotId"
              class="flex items-center gap-1 rounded-lg bg-gray-50 px-2 py-1 text-xs text-gray-800"
            >
              {{ store.elementLabelOf(plotId) }}
              <button type="button" aria-label="移除情节" class="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600" @click="removePlot(plotId)">×</button>
            </li>
          </ul>
        </fieldset>

        <!-- 关联章节（ChapterPicker 添加器 + 叙述方式行） -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">关联章节（按全本章号；可消歧重号）</legend>
          <ChapterPicker
            :multiple="true"
            :model-value="[]"
            :entries="catalog.entries.value"
            :catalog-ready="catalog.catalogReady.value"
            :suggested-number="catalog.suggestedNumber.value"
            :create-handler="catalog.createChapter"
            :session-key="store.selectedEventId"
            placeholder="搜索章号或标题添加…"
            @update:model-value="onAddChapters"
            @retry-load="catalog.retryLoad"
          />
          <ul v-if="chapters.length > 0" class="flex flex-col gap-1.5">
            <li v-for="ref in chapters" :key="ref.chapterNumber" class="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs">
              <span class="min-w-0 flex-1 truncate text-gray-800">
                第 {{ ref.chapterNumber }} 章
                <template v-if="chapterEntryOf(ref.chapterNumber)">· {{ chapterEntryOf(ref.chapterNumber)!.title }}</template>
                <span v-else-if="isAmbiguousChapter(ref.chapterNumber)" class="text-amber-600">· 章号重复，待消歧</span>
                <span v-else class="text-red-500">· 章节已删除（悬空引用）</span>
              </span>
              <select
                :value="ref.mode"
                aria-label="叙述方式"
                class="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700 outline-none"
                @change="setChapterMode(ref.chapterNumber, ($event.target as HTMLSelectElement).value as NarrativeMode)"
              >
                <option v-for="mode in ['current', 'recall', 'prophecy', 'dream'] as const" :key="mode" :value="mode">{{ narrativeModeLabel(mode) }}</option>
              </select>
              <button type="button" aria-label="移除章节" class="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600" @click="removeChapter(ref.chapterNumber)">×</button>
            </li>
          </ul>
        </fieldset>

        <!-- 因果前驱 -->
        <fieldset class="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <legend class="px-1 text-xs text-gray-500">因果前驱（这件事由哪些事件引起）</legend>
          <div class="relative">
            <button
              type="button"
              class="w-full rounded-lg border border-gray-300 px-2.5 py-1 text-left text-xs text-gray-500 transition-colors hover:bg-gray-50"
              @click="causedByOpen = !causedByOpen"
            >
              + 添加前驱事件…
            </button>
            <ul
              v-if="causedByOpen && causedByCandidates.length > 0"
              class="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            >
              <li v-for="option in causedByCandidates" :key="option.eventId">
                <button
                  type="button"
                  class="w-full truncate px-3 py-1.5 text-left text-sm text-gray-800 transition-colors hover:bg-gray-50"
                  @mousedown.prevent="addCausedBy(option.eventId)"
                >
                  {{ option.title }}
                </button>
              </li>
            </ul>
          </div>
          <ul v-if="draft.causedBy.length > 0" class="flex flex-col gap-1">
            <li v-for="eventId in draft.causedBy" :key="eventId" class="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1 text-xs text-gray-800">
              <span class="min-w-0 flex-1 truncate">{{ eventTitleOf(eventId) }}</span>
              <button type="button" aria-label="移除前驱" class="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600" @click="removeCausedBy(eventId)">×</button>
            </li>
          </ul>
        </fieldset>

        <p class="text-[11px] text-gray-400">
          区间事件在时间轴上显示为横条，从开始位置画到结束位置；中间可以插入其他事件。
        </p>
      </div>

      <div class="mt-auto shrink-0 border-t border-gray-100 p-3">
        <button
          type="button"
          :class="[
            'w-full rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            confirmDelete
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'border border-red-200 text-red-600 hover:bg-red-50',
          ]"
          @click="removeEvent"
        >
          {{ confirmDelete ? '再点一次确认删除' : '删除这条事件' }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p class="text-sm text-gray-500">点击时间轴上的标记查看事件详情</p>
      <p class="text-xs text-gray-400">或点击上方「新建事件」</p>
    </div>
  </section>
</template>
