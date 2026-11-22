<script setup lang="ts">
/**
 * 时间轴弹窗（时间线 JSON 化施工计划 §9.4）：组合 WorkspaceModal 外壳，
 * 内部左时间轴（TimelineAxis，甘特视图，只读不可拖动）右详情（TimelineDetail），工具条含搜索、
 * 类型/叙述方式筛选、参与要素筛选（人物/情节）、缩放（最小列宽）、检查入口
 * （账本 issue 徽标 + 一键清理 + 全量检查）、新建事件。
 *
 * 损坏态：主体替换为只读原始内容 + 「重新初始化（副本入回收站）」出口。
 * 窄屏（<lg）：详情区改纵向堆叠（时间轴固定高度 + 详情独立滚动）。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { useTimelineStore } from '../../stores/timeline'
import { elementRefKey } from '../../utils/element-ref-key'
import type { TimelineElementOptionView } from '@novai/core/services/timeline-service'
import WorkspaceModal from '../layout/WorkspaceModal.vue'
import AppIcon from '../ui/AppIcon.vue'
import TimelineAxis from './TimelineAxis.vue'
import TimelineDetail from './TimelineDetail.vue'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useTimelineStore()

const isOpen = computed(() => store.projectId === props.projectId && store.loadState !== 'idle')

onMounted(() => {
  void store.open(props.projectId)
})

/* ---------- 工具条 ---------- */

const KIND_OPTIONS = [
  { value: '', label: '全部形态' },
  { value: 'point', label: '点事件' },
  { value: 'span', label: '区间事件' },
] as const

const MODE_OPTIONS = [
  { value: '', label: '全部叙述' },
  { value: 'current', label: '当前线' },
  { value: 'recall', label: '回忆' },
  { value: 'prophecy', label: '预言' },
  { value: 'dream', label: '梦境' },
] as const

const elementQuery = ref('')
const elementOptions = ref<TimelineElementOptionView[]>([])
const elementOpen = ref(false)

let elementToken = 0

watch(elementQuery, async (value) => {
  const token = ++elementToken
  const text = value.trim()
  if (!text) {
    elementOptions.value = []
    return
  }
  const result = await store.searchElementOptions(text)
  if (token === elementToken) {
    elementOptions.value = result
    elementOpen.value = true
  }
})

/** 筛选要素：情节 → 情节筛选；其余类型 → 参与者筛选（一个控件覆盖两类口径） */
function applyElementFilter(option: TimelineElementOptionView) {
  // 尚无标识的要素用 path: 键：它不可能被任何事件引用，筛选结果为空而非静默失效
  const key = elementRefKey(option)
  store.rememberOption(option)
  if (option.type === 'plot') {
    store.filterPlotId = key
    store.filterParticipantId = ''
  } else {
    store.filterParticipantId = key
    store.filterPlotId = ''
  }
  elementQuery.value = ''
  elementOptions.value = []
  elementOpen.value = false
}

function clearElementFilter() {
  store.filterParticipantId = ''
  store.filterPlotId = ''
}

function onElementBlur() {
  setTimeout(() => {
    elementOpen.value = false
  }, 150)
}

const elementFilterLabel = computed(() =>
  store.filterParticipantId || store.filterPlotId
    ? store.elementLabelOf(store.filterParticipantId || store.filterPlotId)
    : '',
)

function clearFilters() {
  store.searchQuery = ''
  store.filterKind = ''
  clearElementFilter()
  store.filterMode = ''
}

const issuesOpen = ref(false)

async function handleClose() {
  await store.close()
  emit('close')
}

function onSelectEvent(eventId: string) {
  void store.openDetail(eventId)
}
</script>

<template>
  <WorkspaceModal
    :is-open="isOpen"
    title="时间轴"
    :subtitle="`${store.eventCount} 个事件 · 按故事内顺序排列`"
    width-class="max-w-6xl"
    height-class="h-[min(90vh,48rem)]"
    :loading="store.isLoading"
    :error="store.loadState === 'error' ? store.actionError || '加载时间线失败' : null"
    :empty="store.isReady && store.eventCount === 0 && !store.createOpen"
    empty-text="还没有任何事件。用右上「新建事件」或让 AI 在写作时登记时间线；事件按故事内顺序排列，支持点事件与区间事件。"
    @close="handleClose"
  >
    <template #actions>
      <button
        type="button"
        class="flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-700"
        @click="store.openCreateForm()"
      >
        <AppIcon name="plus" :size="14" class="h-3.5 w-3.5" />
        新建事件
      </button>
    </template>

    <!-- 损坏态：只读原始内容 + 重置出口 -->
    <div v-if="store.isCorrupt" class="flex h-full flex-col gap-3 p-4">
      <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        时间线账本文件已损坏，读取与写入都被阻止。可以查看原始内容，或把副本放入回收站后重新初始化（当前事件数据将清空）。
      </div>
      <pre class="min-h-0 flex-1 overflow-auto rounded-lg bg-gray-950 p-3 text-xs leading-relaxed text-gray-200">{{ store.corruptRaw }}</pre>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
          @click="store.reinitializeFromCorrupt()"
        >
          副本入回收站并重新初始化
        </button>
      </div>
    </div>

    <!-- 正常态：工具条 + 时间轴/详情 -->
    <div v-else class="flex h-full min-h-0 flex-col">
      <!-- 工具条 -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
        <input
          v-model="store.searchQuery"
          type="text"
          placeholder="搜索事件标题/摘要…"
          aria-label="搜索事件"
          class="w-44 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
        >
        <select
          v-model="store.filterKind"
          aria-label="按事件形态筛选"
          class="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 outline-none"
        >
          <option v-for="option in KIND_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <select
          v-model="store.filterMode"
          aria-label="按叙述方式筛选"
          class="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 outline-none"
        >
          <option v-for="option in MODE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>

        <!-- 参与要素筛选（人物/情节共用一个搜索入口） -->
        <div class="relative">
          <button
            v-if="elementFilterLabel"
            type="button"
            class="flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            @click="clearElementFilter()"
          >
            {{ elementFilterLabel }}
            ×
          </button>
          <input
            v-else
            v-model="elementQuery"
            type="text"
            placeholder="按人物/情节筛选…"
            aria-label="按参与要素筛选"
            class="w-40 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
            @focus="elementOptions.length > 0 && (elementOpen = true)"
            @blur="onElementBlur"
          >
          <ul
            v-if="elementOpen && elementOptions.length > 0"
            class="absolute left-0 top-full z-30 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          >
            <li v-for="option in elementOptions" :key="elementRefKey(option)">
              <button
                type="button"
                class="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
                @mousedown.prevent="applyElementFilter(option)"
              >
                <span class="text-sm text-gray-800">
                  {{ option.name }}
                  <span class="ml-1 text-xs text-gray-400">{{ option.type }}</span>
                </span>
                <span v-if="option.summary" class="w-full truncate text-xs text-gray-400">{{ option.summary }}</span>
              </button>
            </li>
          </ul>
        </div>

        <button
          v-if="store.hasFilter"
          type="button"
          class="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50"
          @click="clearFilters()"
        >
          清除筛选
        </button>

        <!-- 缩放 = 最小列宽（甘特排布放不下时实际列宽自动更宽）；轴上滚轮/捏合同步改这个值 -->
        <label class="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
          缩放
          <input
            v-model.number="store.stepPx"
            type="range"
            min="48"
            max="240"
            step="1"
            aria-label="时间轴缩放"
            class="h-1 w-24 cursor-pointer accent-indigo-600"
          >
        </label>

        <button
          type="button"
          :class="[
            'flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors',
            store.issueCount > 0
              ? 'border border-amber-300 bg-amber-50 font-medium text-amber-700 hover:bg-amber-100'
              : 'border border-gray-300 text-gray-600 hover:bg-gray-50',
          ]"
          @click="issuesOpen = !issuesOpen"
        >
          <AppIcon name="circle-alert" :size="14" class="h-3.5 w-3.5" />
          数据检查
          <span v-if="store.issueCount > 0">{{ store.issueCount }}</span>
        </button>
      </div>

      <!-- 检查面板：账本隔离条目 + 一键清理；全量检查（悬空引用等） -->
      <div v-if="issuesOpen" class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
        <template v-if="store.issueCount > 0">
          <ul class="mb-2 flex flex-col gap-1 text-xs text-amber-800">
            <li v-for="(issue, index) in store.view?.issues ?? []" :key="index">· 第 {{ issue.index + 1 }} 条标记异常（{{ issue.kind }}）：异常数据已隔离，清理将移除这些条目</li>
          </ul>
          <button
            type="button"
            class="mb-2 rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
            @click="store.cleanupIssues()"
          >
            一键清理异常条目
          </button>
        </template>
        <div class="flex items-center gap-2">
          <button
            type="button"
            :disabled="store.checkBusy"
            class="rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
            @click="store.runCheck()"
          >
            {{ store.checkBusy ? '检查中…' : '全量检查（引用与互引）' }}
          </button>
          <span v-if="store.issueCount === 0" class="text-xs text-green-700">账本结构健康：无非法条目。</span>
        </div>
        <ul v-if="store.checkIssues.length > 0" class="mt-2 flex flex-col gap-1 text-xs text-amber-800">
          <li v-for="(issue, index) in store.checkIssues" :key="index">
            · {{ issue.kind === 'dangling-participant' || issue.kind === 'dangling-plot'
              ? `事件 ${issue.eventId} 引用的要素 ${issue.id} 已删除`
              : issue.kind === 'ambiguous-participant' || issue.kind === 'ambiguous-plot'
                ? `事件 ${issue.eventId} 引用的标识 ${issue.id} 被多个要素占用`
                : issue.kind === 'missing-chapter'
                  ? `事件 ${issue.eventId} 关联的第 ${issue.chapterNumber} 章已删除`
                  : issue.kind === 'ambiguous-chapter'
                    ? `事件 ${issue.eventId} 关联的第 ${issue.chapterNumber} 章存在重号，待消歧`
                    : issue.kind === 'dangling-caused-by'
                      ? `事件 ${issue.eventId} 的因果前驱 ${issue.targetEventId} 已删除`
                      : issue.kind === 'dangling-relative-anchor'
                        ? `事件 ${issue.eventId} 的相对时间锚 ${issue.anchorEventId} 已删除`
                        : `第 ${(issue as { index: number }).index + 1} 条标记异常（${(issue as { kind: string }).kind}）` }}
          </li>
        </ul>
        <p v-else-if="store.checkIssues.length === 0 && !store.checkBusy" class="mt-1 text-xs text-green-700">全量检查未发现问题。</p>
      </div>

      <!-- 时间轴 + 详情：宽屏左右分栏；窄屏上下堆叠 -->
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <!-- min-w-0：宽时间轴只在自身容器内横向滚动，不把详情区挤出视口 -->
        <div class="relative min-h-[15rem] min-w-0 flex-1 border-b border-gray-100 lg:border-b-0 lg:border-r">
          <TimelineAxis
            :nodes="store.axisNodes"
            :entries="store.ganttEntries"
            :step-px="store.stepPx"
            :selected-event-id="store.selectedEventId"
            @select-event="onSelectEvent"
            @zoom="store.stepPx = $event"
          />
          <p v-if="store.hasFilter && store.matchedEventIds.size === 0" class="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-xs text-gray-400">
            当前筛选条件下没有匹配事件（标记已淡出显示）
          </p>
          <p v-if="store.actionError" class="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-red-50 px-3 py-1 text-xs text-red-700 shadow">
            {{ store.actionError }}
          </p>
        </div>
        <aside class="min-h-0 w-full shrink-0 lg:w-80 xl:w-96">
          <TimelineDetail />
        </aside>
      </div>
    </div>
  </WorkspaceModal>
</template>
