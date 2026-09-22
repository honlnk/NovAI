<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ChatMessageView, FileChangeRecordView, TurnFileChangeView } from '@novai/core/services/types'

import DiffLines from './DiffLines.vue'

/**
 * 任务完成 diff 面板（文档 3 S5）：change-summary 消息的渲染体，随消息持久化，
 * 重载后每一轮的面板都在原位。按文件聚合：一行一个文件（净状态徽章 + 聚合行数），
 * 回答「此次任务改了哪些文件、每个文件总共改了什么」，而非平铺操作流水。
 * 默认最新一轮展开文件列表、历史轮折叠成标题行；diff 区默认全收起、点开才算（lazy），
 * 展开区限高 30 行（600px ≈ 30 × leading-5），超出内部滚动。
 */
const props = defineProps<{
  message: Extract<ChatMessageView, { kind: 'change-summary' }>
  /** 是否最新一轮（默认展开文件列表；历史轮默认只显示标题行） */
  newest?: boolean
}>()

const filesExpanded = ref(props.newest === true)
/** 展开的文件行 path 集合（lazy：点开才算，避免长章节一次性渲染） */
const expandedPaths = ref(new Set<string>())

const linesAdded = computed(() =>
  props.message.files.reduce((sum, file) => sum + file.linesAdded, 0),
)
const linesRemoved = computed(() =>
  props.message.files.reduce((sum, file) => sum + file.linesRemoved, 0),
)

/** 该文件本轮携带片段 diff 的记录（展开区按账本顺序逐段渲染） */
function diffRecords(file: TurnFileChangeView): FileChangeRecordView[] {
  return file.records.filter((record) => record.diff)
}

function toggleFiles() {
  filesExpanded.value = !filesExpanded.value
}

function toggleDiff(path: string) {
  if (expandedPaths.value.has(path)) {
    expandedPaths.value.delete(path)
  } else {
    expandedPaths.value.add(path)
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
    v-if="message.files.length === 0 && message.aborted"
    class="text-xs text-gray-400"
  >
    本轮已被用户停止
  </div>

  <!-- 账本缺该 runId 的异常旧数据：降级文本 -->
  <div
    v-else-if="message.files.length === 0"
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
        <span v-if="message.aborted" class="text-amber-600">已停止 · </span>本轮写回 {{ message.files.length }} 个文件
      </span>
      <span class="ml-auto shrink-0 font-mono text-xs">
        <span class="text-green-600">+{{ linesAdded }}</span>
        <span class="mx-1 text-gray-300">/</span>
        <span class="text-red-600">−{{ linesRemoved }}</span>
      </span>
    </button>

    <!-- 文件列表：一行一个文件（净状态 + 聚合行数）；同文件多次操作已折叠，片段明细在展开区 -->
    <div v-if="filesExpanded" class="border-t border-gray-100">
      <div
        v-for="file in message.files"
        :key="file.path"
        class="border-b border-gray-50 last:border-b-0"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-600 transition-colors hover:bg-gray-50"
          :class="{ 'cursor-default': diffRecords(file).length === 0 }"
          @click="diffRecords(file).length > 0 && toggleDiff(file.path)"
        >
          <span class="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
            {{ changeLabels[file.status] }}
          </span>
          <span class="min-w-0 flex-1 truncate">
            <template v-if="file.status === 'renamed' && file.fromPath">
              {{ file.fromPath }} <span class="text-gray-400">→</span> {{ file.path }}
            </template>
            <template v-else-if="file.status === 'deleted'">
              {{ file.path }}<span class="ml-1 text-gray-400">（已删除）</span>
            </template>
            <template v-else>
              {{ file.path }}
            </template>
          </span>
          <span
            v-if="diffRecords(file).length > 0"
            class="shrink-0 font-mono"
          >
            <span class="text-green-600">+{{ file.linesAdded }}</span>
            <span class="ml-1 text-red-600">−{{ file.linesRemoved }}</span>
          </span>
        </button>
        <!-- diff 视图（lazy，点开才算；整个展开区限高 30 行，超出内部滚动） -->
        <div
          v-if="expandedPaths.has(file.path)"
          class="mx-3 mb-2 max-h-[600px] overflow-y-auto"
        >
          <div
            v-for="(record, index) in diffRecords(file)"
            :key="record.id"
            class="mt-1 first:mt-0"
          >
            <div
              v-if="diffRecords(file).length > 1"
              class="px-1 pb-0.5 text-[10px] text-gray-400"
            >
              第 {{ index + 1 }} 处修改
            </div>
            <DiffLines :old-text="record.diff!.oldText" :new-text="record.diff!.newText" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
