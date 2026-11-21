<script setup lang="ts">
import type { ChapterCatalog } from '@novai/core/types/chapters'
import ChapterPicker from '../card-board/ChapterPicker.vue'
import type { ChapterCreateHandler } from '../card-board/chapter-picker-state'
import PlannedPositionPicker from './PlannedPositionPicker.vue'
import PanelHeader from '../layout/PanelHeader.vue'

/**
 * 新建伏笔面板（右侧内容面板）：伏笔名/读者视角/埋设章节必填，作者真相与
 * 回收窗口可选。埋设章节与窗口起止走阶段 2 的选择器（可搜索、真实新建、
 * 结构化位置），不再依赖手输文件名。草稿真值在 foreshadowing store：创建
 * 等待真实结果，失败保留全部输入；取消不清输入（与计划新建面板同一交互约定）。
 */
defineProps<{
  newName: string
  newReaderView: string
  newAuthorTruth: string
  newPlantedAt: string
  /** 回收窗口起点/终点的编码字符串（'' = 未选；终点留空 = 开放终点） */
  newPayoffStart: string
  newPayoffEnd: string
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
  latestChapterNumber: number | null
  /** 三个必填项是否齐全（提交按钮可用口径） */
  canSubmit: boolean
  isCreating: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateCreateDraft: [partial: { name?: string; readerView?: string; authorTruth?: string; plantedAt?: string; payoffStart?: string; payoffEnd?: string }]
  submitCreate: []
  retryChapterLoad: []
  /** 取消：回到当前详情，新建草稿保留 */
  cancel: []
}>()

function onInput(field: 'name' | 'readerView' | 'authorTruth', event: Event) {
  emit('updateCreateDraft', { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
}

function onPlantedPick(value: string | string[] | null) {
  if (typeof value === 'string' && value !== '') {
    emit('updateCreateDraft', { plantedAt: value })
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="foreshadowing-create-panel">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <h2 class="truncate text-sm font-semibold text-gray-800">登记伏笔</h2>
      </template>
    </PanelHeader>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <div class="grid shrink-0 grid-cols-2 gap-2">
        <input
          type="text"
          class="col-span-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="伏笔名（必填，如：旧照片之谜）"
          data-testid="foreshadowing-new-name"
          :value="newName"
          @input="onInput('name', $event)"
        >
        <div class="col-span-2">
          <p class="mb-1 text-[11px] font-medium text-gray-500">埋设章节（必填）</p>
          <ChapterPicker
            :model-value="newPlantedAt === '' ? null : newPlantedAt"
            :entries="picker.catalog.entries"
            :catalog-ready="picker.catalogReady"
            :loading="picker.loading"
            :load-error="picker.loadError"
            allow-create
            :suggested-number="picker.suggestedNumber"
            :session-key="`${picker.sessionKey}:planted`"
            :create-handler="picker.createHandler"
            placeholder="搜索并选择埋设章节…"
            @update:model-value="onPlantedPick"
            @retry-load="emit('retryChapterLoad')"
          />
        </div>
        <div class="col-span-2">
          <p class="mb-1 text-[11px] font-medium text-gray-500">回收窗口（可选）</p>
          <div class="space-y-1.5">
            <PlannedPositionPicker
              :model-value="newPayoffStart === '' ? 'none' : newPayoffStart"
              :entries="picker.catalog.entries"
              :catalog-ready="picker.catalogReady"
              :loading="picker.loading"
              :load-error="picker.loadError"
              allow-create
              :suggested-number="picker.suggestedNumber"
              :session-key="`${picker.sessionKey}:start`"
              :create-handler="picker.createHandler"
              :latest-chapter-number="latestChapterNumber"
              @update:model-value="(value) => emit('updateCreateDraft', { payoffStart: value === 'none' ? '' : value })"
            />
            <PlannedPositionPicker
              :model-value="newPayoffStart === '' ? 'none' : (newPayoffEnd === '' ? 'open' : newPayoffEnd)"
              :entries="picker.catalog.entries"
              :catalog-ready="picker.catalogReady"
              :loading="picker.loading"
              :load-error="picker.loadError"
              allow-create
              :suggested-number="picker.suggestedNumber"
              :session-key="`${picker.sessionKey}:end`"
              :create-handler="picker.createHandler"
              :latest-chapter-number="latestChapterNumber"
              allow-open
              :disabled="newPayoffStart === ''"
              @update:model-value="(value) => emit('updateCreateDraft', { payoffEnd: value === 'open' || value === 'none' ? '' : value })"
            />
            <p v-if="newPayoffStart === ''" class="text-[11px] text-gray-400">先选起点；终点可留空表示开放终点。</p>
          </div>
        </div>
      </div>

      <textarea
        class="min-h-24 w-full shrink-0 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder="读者视角（必填）：埋设当时读者能看到的事实，不含剧透。"
        data-testid="foreshadowing-new-reader-view"
        :value="newReaderView"
        @input="onInput('readerView', $event)"
      />
      <textarea
        class="min-h-16 w-full flex-1 resize-none rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        placeholder="作者真相（可选，剧透）：这条伏笔的钥匙——回收时读者将知道什么。"
        data-testid="foreshadowing-new-author-truth"
        :value="newAuthorTruth"
        @input="onInput('authorTruth', $event)"
      />

      <p v-if="actionError" class="shrink-0 text-xs text-red-600">{{ actionError }}</p>

      <div class="flex shrink-0 items-center gap-2">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="isCreating || !canSubmit"
          data-testid="foreshadowing-new-submit"
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
