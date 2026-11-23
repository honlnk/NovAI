<script setup lang="ts">
import { RHYTHM_HOOKS, RHYTHM_MOODS, RHYTHM_MOOD_DESCRIPTIONS, RHYTHM_PAYOFFS } from '@novai/core/types/rhythm'
import type { ChapterCatalog } from '@novai/core/types/chapters'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import type { ChapterCreateHandler } from '../card-board/chapter-picker-state'
import PanelHeader from '../layout/PanelHeader.vue'

/**
 * 新建节奏卡面板（右侧内容面板）：关联章节走阶段 1/2 的选择器（可搜索、真实
 * 新建、一章一卡在提交时校验），四个计划值必填（卡名缺省按章段生成，角色与
 * 节奏意图可选）。草稿真值在 rhythm store：创建等待真实结果，失败保留全部
 * 输入；取消不清输入（与计划/伏笔新建面板同一交互约定）。
 */
defineProps<{
  newName: string
  newChapterRef: string
  newPlannedConflict: number
  newPlannedMood: string
  newPlannedHook: string
  newPlannedPayoff: string
  newPlannedCharacters: string
  newIntentBody: string
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
  canSubmit: boolean
  isCreating: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateCreateDraft: [partial: {
    name?: string
    chapterRef?: string
    plannedConflict?: number
    plannedMood?: string
    plannedHook?: string
    plannedPayoff?: string
    plannedCharacters?: string
    intentBody?: string
  }]
  submitCreate: []
  retryChapterLoad: []
  cancel: []
}>()

function onTextField(field: 'name' | 'plannedCharacters' | 'intentBody', event: Event) {
  emit('updateCreateDraft', { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
}

function onChapterPick(value: string | string[] | null) {
  if (typeof value === 'string' && value !== '') {
    emit('updateCreateDraft', { chapterRef: value })
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="rhythm-create-panel">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <h2 class="truncate text-sm font-semibold text-gray-800">规划节奏卡</h2>
      </template>
    </PanelHeader>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <div class="grid shrink-0 grid-cols-2 gap-2">
        <div class="col-span-2">
          <p class="mb-1 text-[11px] font-medium text-gray-500">关联章节（必填，一章一卡）</p>
          <ChapterPicker
            :model-value="newChapterRef === '' ? null : newChapterRef"
            :entries="picker.catalog.entries"
            :catalog-ready="picker.catalogReady"
            :loading="picker.loading"
            :load-error="picker.loadError"
            allow-create
            :suggested-number="picker.suggestedNumber"
            :session-key="`${picker.sessionKey}:chapter`"
            :create-handler="picker.createHandler"
            placeholder="搜索并选择关联章节…"
            @update:model-value="onChapterPick"
            @retry-load="emit('retryChapterLoad')"
          />
        </div>
        <input
          type="text"
          class="col-span-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="节奏卡名（可选，缺省按章段生成「第083章节奏」）"
          data-testid="rhythm-new-name"
          :value="newName"
          @input="onTextField('name', $event)"
        >
      </div>

      <!-- 计划值：冲突强度滑块 + 三个枚举下拉 -->
      <div class="shrink-0 rounded-md border border-gray-200 px-3 py-2.5">
        <p class="mb-2 text-[11px] font-medium text-gray-500">计划值（必填）</p>
        <div class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-xs text-gray-600">冲突强度</span>
          <input
            type="range"
            min="1"
            max="10"
            step="1"
            class="h-1.5 flex-1 accent-gray-900"
            :value="newPlannedConflict"
            data-testid="rhythm-new-conflict-slider"
            @input="emit('updateCreateDraft', { plannedConflict: Number(($event.target as HTMLInputElement).value) })"
          >
          <span
            :class="[
              'w-10 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold',
              newPlannedConflict >= 7 ? 'bg-red-100 text-red-700' : newPlannedConflict >= 4 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700',
            ]"
          >{{ newPlannedConflict }}</span>
        </div>
        <div class="mt-2 grid grid-cols-3 gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">情绪基调</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
              :value="newPlannedMood"
              data-testid="rhythm-new-mood"
              @change="emit('updateCreateDraft', { plannedMood: ($event.target as HTMLSelectElement).value })"
            >
              <option value="" disabled>选择…</option>
              <option v-for="mood in RHYTHM_MOODS" :key="mood" :value="mood" :title="RHYTHM_MOOD_DESCRIPTIONS[mood]">{{ mood }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">章末钩子</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
              :value="newPlannedHook"
              data-testid="rhythm-new-hook"
              @change="emit('updateCreateDraft', { plannedHook: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="hook in RHYTHM_HOOKS" :key="hook" :value="hook">{{ hook }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-600">爽点类型</span>
            <select
              class="rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800"
              :value="newPlannedPayoff"
              data-testid="rhythm-new-payoff"
              @change="emit('updateCreateDraft', { plannedPayoff: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="payoff in RHYTHM_PAYOFFS" :key="payoff" :value="payoff">{{ payoff }}</option>
            </select>
          </label>
        </div>
        <div class="mt-2">
          <span class="text-xs text-gray-600">出场角色（可选，顿号分隔）</span>
          <input
            type="text"
            class="mt-1 w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="如：林远、苏晚"
            :value="newPlannedCharacters"
            @input="onTextField('plannedCharacters', $event)"
          >
        </div>
      </div>

      <textarea
        class="min-h-20 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder="节奏意图（可选）：本章要什么温度、不要什么；和前后章怎么衔接。"
        data-testid="rhythm-new-intent-body"
        :value="newIntentBody"
        @input="onTextField('intentBody', $event)"
      />

      <p v-if="actionError" class="shrink-0 text-xs text-red-600">{{ actionError }}</p>

      <div class="flex shrink-0 items-center gap-2">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="isCreating || !canSubmit"
          data-testid="rhythm-new-submit"
          @click="emit('submitCreate')"
        >
          {{ isCreating ? '创建中…' : '登记' }}
        </button>
        <button
          class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-50"
          @click="emit('cancel')"
        >
          取消
        </button>
      </div>
    </div>
  </div>
</template>
