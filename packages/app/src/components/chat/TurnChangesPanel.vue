<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ChatMessageView, FileChangeRecordView } from '@novai/core/services/types'

import DiffLines from './DiffLines.vue'

/**
 * 任务完成 diff 面板（文档 3 S5）：change-summary 消息的渲染体，随消息持久化，
 * 重载后每一轮的面板都在原位。默认最新一轮展开文件列表、历史轮折叠成标题行；
 * diff 区默认全收起、点开才算（lazy）。
 */
const props = defineProps<{
  message: Extract<ChatMessageView, { kind: 'change-summary' }>
  /** 是否最新一轮（默认展开文件列表；历史轮默认只显示标题行） */
  newest?: boolean
}>()

const filesExpanded = ref(props.newest === true)
/** 展开的 diff 记录 id 集合（lazy：点开才算，避免长章节一次性渲染） */
const expandedDiffIds = ref(new Set<string>())

/** 标题行的 N：本轮去重路径数 */
const fileCount = computed(() => {
  const paths = new Set(props.message.changes.map((record) => recordPath(record)))
  return paths.size
})

const linesAdded = computed(() =>
  props.message.changes.reduce((sum, record) => sum + (record.diff?.linesAdded ?? 0), 0),
)
const linesRemoved = computed(() =>
  props.message.changes.reduce((sum, record) => sum + (record.diff?.linesRemoved ?? 0), 0),
)

function recordPath(record: FileChangeRecordView): string {
  return record.change.type === 'renamed' ? record.change.toPath : record.change.path
}

function toggleFiles() {
  filesExpanded.value = !filesExpanded.value
}

function toggleDiff(id: string) {
  if (expandedDiffIds.value.has(id)) {
    expandedDiffIds.value.delete(id)
  } else {
    expandedDiffIds.value.add(id)
  }
}

const changeLabels: Record<string, string> = {
  created: '新建',
  updated: '修改',
  renamed: '改名',
  deleted: '删除',
}
</script>

<template>
  <!-- 停止且无任何改动：一行降级文本（无面板） -->
  <div
    v-if="message.changes.length === 0 && message.aborted"
    class="text-xs text-gray-400"
  >
    本轮已被用户停止
  </div>

  <!-- 账本缺该 runId 的异常旧数据：降级文本 -->
  <div
    v-else-if="message.changes.length === 0"
    class="text-xs text-gray-400"
  >
    本轮改动记录缺失
  </div>

  <div
    v-else
    class="overflow-hidden rounded-lg border border-gray-200 bg-white"
  >
    <!-- 标题行 -->
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50"
      @click="toggleFiles"
    >
      <svg
        class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform"
        :class="filesExpanded ? 'rotate-90' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      <span class="font-medium text-gray-700">
        <span v-if="message.aborted" class="text-amber-600">已停止 · </span>本轮写回 {{ fileCount }} 个文件
      </span>
      <span class="ml-auto shrink-0 font-mono text-xs">
        <span class="text-green-600">+{{ linesAdded }}</span>
        <span class="mx-1 text-gray-300">/</span>
        <span class="text-red-600">−{{ linesRemoved }}</span>
      </span>
    </button>

    <!-- 文件列表：逐条列操作记录（同一文件改两次就是两行，账本天然顺序，不按文件聚合） -->
    <div v-if="filesExpanded" class="border-t border-gray-100">
      <div
        v-for="record in message.changes"
        :key="record.id"
        class="border-b border-gray-50 last:border-b-0"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-600 transition-colors hover:bg-gray-50"
          :class="{ 'cursor-default': !record.diff }"
          @click="record.diff && toggleDiff(record.id)"
        >
          <span class="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
            {{ changeLabels[record.change.type] }}
          </span>
          <span class="min-w-0 flex-1 truncate">
            <template v-if="record.change.type === 'renamed'">
              {{ record.change.fromPath }} <span class="text-gray-400">→</span> {{ record.change.toPath }}
            </template>
            <template v-else-if="record.change.type === 'deleted'">
              {{ record.change.path }}<span class="ml-1 text-gray-400">（已删除）</span>
            </template>
            <template v-else>
              {{ record.change.path }}
            </template>
          </span>
          <span
            v-if="record.diff"
            class="shrink-0 font-mono"
          >
            <span class="text-green-600">+{{ record.diff.linesAdded }}</span>
            <span class="ml-1 text-red-600">−{{ record.diff.linesRemoved }}</span>
          </span>
        </button>
        <!-- diff 视图（lazy，点开才算） -->
        <div
          v-if="record.diff && expandedDiffIds.has(record.id)"
          class="px-3 pb-2"
        >
          <DiffLines :old-text="record.diff.oldText" :new-text="record.diff.newText" />
        </div>
      </div>
    </div>
  </div>
</template>
