<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { ChapterCatalogEntry } from '@novai/core/types/chapters'
import { parsePlannedPosition } from '@novai/core/services/foreshadowing-service'
import type { PlannedPosition, PlannedWindowEnd } from '@novai/core/types/foreshadowing'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import type { ChapterCreateHandler } from '../card-board/chapter-picker-state'
import {
  modeFromEncoded,
  pickerModes,
  relativeSummary,
  validateFutureInput,
  validateRelativeInput,
} from './planned-position-picker-state'

/**
 * 计划回收位置选择器（作者字段控制权计划阶段 2 §三.5）：已有章节 / 最新章节
 * 之后第 N 章 / 指定未来章号三个明确入口；终点另有开放终点，起点以未设置收尾。
 * 相对位置保存固定基准、偏移与确定目标（编码进 modelValue），不随最新章节漂移。
 * 外部写入的原文（raw）以「兼容原文」模式保留展示，作者改为明确位置或清除后
 * 才完成新版编辑；指定未来章号已存在对应章节时直接转为选择该章节。
 */
const props = withDefaults(defineProps<{
  /** 当前编码值（formatPlannedPosition 产物；由父层合并草稿与磁盘基线） */
  modelValue: string
  /** 终点选择器允许「开放终点」；起点为「未设置」 */
  allowOpen?: boolean
  disabled?: boolean
  /** 最新章号（相对位置的基准默认值） */
  latestChapterNumber?: number | null
  // —— 章节选择器转发（已有章节模式共用同一骨架与真实新建入口）——
  entries: ChapterCatalogEntry[]
  catalogReady: boolean
  loading?: boolean
  loadError?: string | null
  allowCreate?: boolean
  suggestedNumber?: number | null
  sessionKey: string
  createHandler?: ChapterCreateHandler | null
}>(), {
  allowOpen: false,
  disabled: false,
  latestChapterNumber: null,
  loading: false,
  loadError: null,
  allowCreate: false,
  suggestedNumber: null,
  createHandler: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const modes = computed(() => pickerModes(props.allowOpen))
const mode = ref(modeFromEncoded(props.modelValue))

// 编码值外部变化（切卡/磁盘刷新）时同步模式与输入区
const parsedValue = computed(() => parsePlannedPosition(props.modelValue))
watch(() => props.modelValue, () => {
  mode.value = modeFromEncoded(props.modelValue)
  syncInputsFromValue()
})
watch(() => props.allowOpen, () => {
  if (!props.allowOpen && mode.value === 'open') {
    mode.value = modeFromEncoded(props.modelValue)
  }
})

/* ---------- 相对位置输入（基准 + 偏移 → 确定目标） ---------- */

const relativeBaseText = ref('')
const relativeOffsetText = ref('')

/* ---------- 未来章号输入 ---------- */

const futureTargetText = ref('')

function syncInputsFromValue(): void {
  const parsed = parsedValue.value
  if (parsed?.kind === 'relative') {
    relativeBaseText.value = String(parsed.base)
    relativeOffsetText.value = String(parsed.offset)
  } else if (parsed?.kind === 'future') {
    futureTargetText.value = String(parsed.target)
  }
}
syncInputsFromValue()

/** 相对位置的默认基准：选择时的最新章（无章节时从 1 起） */
function defaultRelativeBase(): number {
  return props.latestChapterNumber && props.latestChapterNumber >= 1 ? props.latestChapterNumber : 1
}

function onModeChange(next: string): void {
  const value = next as typeof mode.value
  mode.value = value
  if (value === 'none') {
    emit('update:modelValue', 'none')
    return
  }
  if (value === 'open') {
    emit('update:modelValue', 'open')
    return
  }
  if (value === 'relative' && relativeBaseText.value === '') {
    relativeBaseText.value = String(defaultRelativeBase())
  }
  if (value === 'relative' && relativeOffsetText.value === '') {
    relativeOffsetText.value = '1'
    emitRelativeIfValid()
  }
  if (value === 'future' && futureTargetText.value === '' && props.suggestedNumber != null) {
    futureTargetText.value = String(props.suggestedNumber)
    emitFutureIfValid()
  }
}

function emitRelativeIfValid(): void {
  const base = Number.parseInt(relativeBaseText.value, 10)
  const offset = Number.parseInt(relativeOffsetText.value, 10)
  const result = validateRelativeInput(Number.isNaN(base) ? null : base, Number.isNaN(offset) ? null : offset)
  if (result.ok) {
    emit('update:modelValue', `relative:${result.target}:${base}:${offset}`)
  }
}

function onRelativeInput(): void {
  emitRelativeIfValid()
}

/** 指定未来章号：已存在对应章节时直接转为选择该章节（不重复建立位置表达） */
function emitFutureIfValid(): void {
  const target = Number.parseInt(futureTargetText.value, 10)
  const result = validateFutureInput(Number.isNaN(target) ? null : target)
  if (!result.ok) {
    return
  }
  const existing = props.entries.find((entry) => entry.number === result.target)
  if (existing && props.catalogReady) {
    mode.value = 'chapter'
    emit('update:modelValue', `chapter:${existing.ref}`)
    return
  }
  emit('update:modelValue', `future:${result.target}`)
}

function onFutureInput(): void {
  emitFutureIfValid()
}

/** 已选未来/章节目标的展示补充：已有章节带标题，未来章号标「尚未创建」 */
const futureExistingEntry = computed(() => {
  const parsed = parsedValue.value
  if (!props.catalogReady) {
    return null
  }
  const number = parsed?.kind === 'future' ? parsed.target
    : parsed?.kind === 'chapter' ? chapterNumberOf(parsed.ref)
      : null
  if (number === null) {
    return null
  }
  return props.entries.find((entry) => entry.number === number) ?? null
})

function chapterNumberOf(ref: string): number | null {
  const match = /第(\d+)章/.exec(ref)
  return match ? Number(match[1]) : null
}

const chapterModeValue = computed(() => {
  const parsed = parsedValue.value
  return parsed?.kind === 'chapter' ? parsed.ref : null
})

const relativeInfo = computed(() => relativeSummary(
  Number.parseInt(relativeBaseText.value, 10) || null,
  Number.parseInt(relativeOffsetText.value, 10) || null,
))

const futureError = computed(() => {
  if (mode.value !== 'future') {
    return ''
  }
  const target = Number.parseInt(futureTargetText.value, 10)
  return validateFutureInput(Number.isNaN(target) ? null : target).ok ? '' : '章号须为正整数'
})

const relativeError = computed(() => {
  if (mode.value !== 'relative') {
    return ''
  }
  const base = Number.parseInt(relativeBaseText.value, 10)
  const offset = Number.parseInt(relativeOffsetText.value, 10)
  const result = validateRelativeInput(Number.isNaN(base) ? null : base, Number.isNaN(offset) ? null : offset)
  return result.ok ? '' : result.message
})

const displayText = computed(() => {
  const parsed = parsedValue.value as PlannedPosition | PlannedWindowEnd | null
  switch (parsed?.kind) {
    case 'none':
      return '未设置'
    case 'open':
      return '开放终点（暂无截止章）'
    case 'chapter':
      return futureExistingEntry.value
        ? `第${futureExistingEntry.value.number}章 ${futureExistingEntry.value.title}`
        : parsed.ref
    case 'future':
      return futureExistingEntry.value
        ? `第${parsed.target}章 ${futureExistingEntry.value.title}`
        : `第${parsed.target}章（尚未创建）`
    case 'relative':
      return `第${parsed.base}章之后 ${parsed.offset} 章 → 第${parsed.target}章（基准已固定）`
    case 'raw':
      return parsed.raw
    default:
      return '未设置'
  }
})

/** 兼容原文标记：外部写入的无法归类值（不在正常模式内，须明确处理） */
const isRaw = computed(() => mode.value === 'raw')

function onChapterPick(value: string | string[] | null): void {
  if (typeof value === 'string' && value !== '') {
    emit('update:modelValue', `chapter:${value}`)
  }
}
</script>

<template>
  <div class="w-full" data-testid="planned-position-picker">
    <div class="flex items-center gap-2">
      <select
        class="w-40 shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400"
        :value="isRaw ? 'raw' : mode"
        :disabled="disabled"
        data-testid="planned-position-mode"
        @change="onModeChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="item in modes" :key="item.value" :value="item.value">{{ item.label }}</option>
        <option v-if="isRaw" value="raw">兼容原文（待确认）</option>
      </select>
      <span class="min-w-0 flex-1 truncate text-xs text-gray-500" data-testid="planned-position-display">{{ displayText }}</span>
    </div>

    <!-- 兼容原文：保留展示，作者须明确改为章节/未来位置或清除 -->
    <p v-if="isRaw" class="mt-1 text-[11px] leading-4 text-amber-600" data-testid="planned-position-raw-hint">
      这段文字无法归类为章节或未来章号，按原文保留。请改为明确的计划位置，或清除（未设置）后保存。
    </p>

    <!-- 已有章节：共用章节选择器骨架（搜索、键盘、真实新建入口） -->
    <ChapterPicker
      v-if="mode === 'chapter' && !isRaw"
      :model-value="chapterModeValue"
      :entries="entries"
      :catalog-ready="catalogReady"
      :loading="loading"
      :load-error="loadError"
      :allow-create="allowCreate && !disabled"
      :suggested-number="suggestedNumber"
      :session-key="`${sessionKey}:position`"
      :create-handler="createHandler"
      :disabled="disabled"
      placeholder="搜索并选择章节…"
      class="mt-1"
      @update:model-value="onChapterPick"
    />

    <!-- 相对位置：基准 + 偏移（默认最新章 + 1），目标保存时确定 -->
    <div v-else-if="mode === 'relative' && !isRaw" class="mt-1 flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1 text-[11px] text-gray-500">
        基准章号
        <input
          type="number"
          min="1"
          class="w-16 rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          data-testid="planned-position-relative-base"
          :value="relativeBaseText"
          :disabled="disabled"
          @input="relativeBaseText = ($event.target as HTMLInputElement).value; onRelativeInput()"
        >
      </label>
      <label class="flex items-center gap-1 text-[11px] text-gray-500">
        之后
        <input
          type="number"
          min="1"
          class="w-14 rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          data-testid="planned-position-relative-offset"
          :value="relativeOffsetText"
          :disabled="disabled"
          @input="relativeOffsetText = ($event.target as HTMLInputElement).value; onRelativeInput()"
        >
        章
      </label>
      <span class="text-[11px] text-gray-500">{{ relativeInfo }}</span>
      <p v-if="relativeError" class="w-full text-[11px] text-red-600">{{ relativeError }}</p>
    </div>

    <!-- 指定未来章号：正整数即可；已存在时切换为选择该章节 -->
    <div v-else-if="mode === 'future' && !isRaw" class="mt-1 flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1 text-[11px] text-gray-500">
        第
        <input
          type="number"
          min="1"
          class="w-16 rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          data-testid="planned-position-future-target"
          :value="futureTargetText"
          :disabled="disabled"
          @input="futureTargetText = ($event.target as HTMLInputElement).value; onFutureInput()"
        >
        章
      </label>
      <span v-if="!futureError" class="text-[11px] text-gray-500">
        {{ futureExistingEntry ? `已存在：${futureExistingEntry.title}` : '尚未创建（合法计划，不需要先建空章节）' }}
      </span>
      <p v-else class="w-full text-[11px] text-red-600">{{ futureError }}</p>
    </div>
  </div>
</template>
