<script setup lang="ts">
import PanelHeader from '../layout/PanelHeader.vue'

/**
 * 新建计划面板（右侧内容面板的新建内容类型，布局统一计划 D3/§4.9）：
 * 与计划详情共用右侧面板、同一时刻只显示其中一种；由看板内嵌深色抽屉迁出，浅色视觉。
 * 草稿真值在 plan store：创建等待真实结果，失败保留全部输入；取消不清输入。
 */
const props = defineProps<{
  newCardTitle: string
  newCardBody: string
  isCreating: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateCreateDraft: [title: string, body: string]
  submitCreate: []
  /** 取消 / 关闭：仅切换展示对象，新建草稿保留（§2.7） */
  cancel: []
}>()

function onTitleInput(event: Event) {
  emit('updateCreateDraft', (event.target as HTMLInputElement).value, props.newCardBody)
}

function onBodyInput(event: Event) {
  emit('updateCreateDraft', props.newCardTitle, (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="plan-create-panel">
    <PanelHeader @close="emit('cancel')">
      <template #leading>
        <h2 class="truncate text-sm font-semibold text-gray-800">新建计划</h2>
      </template>
    </PanelHeader>

    <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      <input
        type="text"
        class="w-full shrink-0 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder="计划名（保存后默认进入收集箱）"
        data-testid="plan-new-card-title"
        :value="newCardTitle"
        @input="onTitleInput"
      >
      <textarea
        class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder="正文（Markdown，可留空）"
        data-testid="plan-new-card-input"
        :value="newCardBody"
        @input="onBodyInput"
      />

      <p v-if="actionError" class="shrink-0 text-xs text-red-600">{{ actionError }}</p>

      <div class="flex shrink-0 items-center gap-2">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="isCreating || (!newCardTitle.trim() && !newCardBody.trim())"
          data-testid="plan-new-card-submit"
          @click="emit('submitCreate')"
        >
          {{ isCreating ? '创建中…' : '创建' }}
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
