<script setup lang="ts">
import PanelHeader from '../layout/PanelHeader.vue'

/**
 * 新建伏笔面板（右侧内容面板）：伏笔名/读者视角/埋设章节必填，作者真相与
 * 回收窗口可选。草稿真值在 foreshadowing store：创建等待真实结果，失败保留
 * 全部输入；取消不清输入（与计划新建面板同一交互约定）。
 */
defineProps<{
  newName: string
  newReaderView: string
  newAuthorTruth: string
  newPlantedAt: string
  newPayoffStart: string
  newPayoffEnd: string
  /** 三个必填项是否齐全（提交按钮可用口径） */
  canSubmit: boolean
  isCreating: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateCreateDraft: [partial: { name?: string; readerView?: string; authorTruth?: string; plantedAt?: string; payoffStart?: string; payoffEnd?: string }]
  submitCreate: []
  /** 取消：回到当前详情，新建草稿保留 */
  cancel: []
}>()

function onInput(field: 'name' | 'readerView' | 'authorTruth' | 'plantedAt' | 'payoffStart' | 'payoffEnd', event: Event) {
  emit('updateCreateDraft', { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
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
        <input
          type="text"
          class="col-span-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="埋设章节（必填，如：第一卷/第012章）"
          data-testid="foreshadowing-new-planted-at"
          :value="newPlantedAt"
          @input="onInput('plantedAt', $event)"
        >
        <input
          type="text"
          class="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="回收窗口起（可选）"
          data-testid="foreshadowing-new-payoff-start"
          :value="newPayoffStart"
          @input="onInput('payoffStart', $event)"
        >
        <input
          type="text"
          class="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="回收窗口止（可选）"
          data-testid="foreshadowing-new-payoff-end"
          :value="newPayoffEnd"
          @input="onInput('payoffEnd', $event)"
        >
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
