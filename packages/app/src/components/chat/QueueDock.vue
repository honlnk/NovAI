<script setup lang="ts">
import { computed, ref } from 'vue'

import type { QueuedMessageView } from '@novai/core/services/types'

/**
 * QueueDock（文档 4 S5）：渲染在输入框正上方。
 * 1 条直接显示行；多条默认折叠成「N 条排队消息」计数头 + 展开箭头；空队列不渲染。
 * 每行三个操作：编辑（行内 input，Enter 存 Esc 取消）、删除（撤回）、立即插话（仅运行中可用）。
 */
const props = defineProps<{
  queue: QueuedMessageView[]
  running: boolean
}>()

const emit = defineEmits<{
  (e: 'edit', id: string, text: string): void
  (e: 'remove', id: string): void
  (e: 'steer', id: string): void
}>()

/** 多条默认折叠成计数头，点击展开 */
const expanded = ref(false)

const queuedCount = computed(() => props.queue.filter((m) => m.placement === 'queued').length)

/** 折叠态的可视行：1 条直接显示，多条折叠时只显示计数头（行为空） */
const visibleMessages = computed(() =>
  expanded.value || props.queue.length === 1 ? props.queue : [],
)

const editingId = ref<string | null>(null)
const editingText = ref('')

function startEdit(message: QueuedMessageView) {
  editingId.value = message.id
  editingText.value = message.text
}

function commitEdit() {
  if (editingId.value !== null && editingText.value.trim()) {
    emit('edit', editingId.value, editingText.value.trim())
  }
  editingId.value = null
}

function cancelEdit() {
  editingId.value = null
}
</script>

<template>
  <div
    v-if="queue.length > 0"
    class="mb-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2"
  >
    <!-- 多条：折叠计数头 -->
    <button
      v-if="queue.length > 1"
      type="button"
      class="mb-0 flex w-full items-center gap-2 text-xs font-medium text-blue-700"
      @click="expanded = !expanded"
    >
      <svg
        class="h-3 w-3 transition-transform"
        :class="expanded ? 'rotate-90' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      {{ queuedCount }} 条排队消息
    </button>

    <!-- 消息行：多条折叠时只显示计数头，展开显示全部 -->
    <div
      v-for="message in visibleMessages"
      :key="message.id"
      class="flex items-center gap-2 py-1 text-sm"
    >
      <span
        class="shrink-0 rounded px-1 py-0.5 text-[10px]"
        :class="message.placement === 'steering' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'"
      >
        {{ message.placement === 'steering' ? '插话' : '排队' }}
      </span>

      <!-- 编辑态：行内 input，Enter 存 Esc 取消 -->
      <input
        v-if="editingId === message.id"
        v-model="editingText"
        type="text"
        class="min-w-0 flex-1 rounded border border-blue-200 bg-white px-2 py-0.5 text-sm outline-none focus:border-blue-400"
        @keydown.enter.prevent="commitEdit"
        @keydown.esc.prevent="cancelEdit"
        @blur="commitEdit"
      >
      <span
        v-else
        class="min-w-0 flex-1 truncate text-gray-700"
        :title="message.text"
      >{{ message.text }}</span>

      <!-- 行操作：编辑 / 删除 / 立即插话（仅运行中可用） -->
      <button
        v-if="editingId !== message.id"
        type="button"
        class="shrink-0 text-xs text-gray-400 transition-colors hover:text-blue-600"
        title="编辑"
        @click="startEdit(message)"
      >
        编辑
      </button>
      <button
        type="button"
        class="shrink-0 text-xs text-gray-400 transition-colors hover:text-red-600"
        title="撤回这条排队消息"
        @click="emit('remove', message.id)"
      >
        删除
      </button>
      <button
        v-if="message.placement === 'queued'"
        type="button"
        class="shrink-0 text-xs transition-colors"
        :class="running ? 'text-gray-400 hover:text-amber-600' : 'cursor-not-allowed text-gray-300'"
        :disabled="!running"
        title="升级为插话：下一 step 边界生效（仅运行中可用）"
        @click="running && emit('steer', message.id)"
      >
        立即插话
      </button>
    </div>
  </div>
</template>
