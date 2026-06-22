<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { pickDirectoryChildren } from '../../utils/file-tree'

const props = defineProps<{
  files: ProjectFileNodeView[]
  activeFilePath?: string
}>()

const emit = defineEmits<{
  selectFile: [path: string]
}>()

/**
 * chapters/ 目录的直接子项（保持层级，可能含子目录「卷/部」+ 章节文件）。
 * 章节页本身展示这个平铺列表；子目录通过展开/折叠渲染其子项。
 */
const chapterNodes = computed(() => pickDirectoryChildren(props.files, 'chapters'))

const hasChapters = computed(() => chapterNodes.value.length > 0)

/** 每个目录节点的展开状态，key = 目录 path */
const expandedDirs = ref<Set<string>>(new Set())

function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path)
  } else {
    expandedDirs.value.add(path)
  }
}

function isDirExpanded(path: string) {
  return expandedDirs.value.has(path)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="px-4 py-3">
      <h2 class="text-sm font-semibold text-white">章节</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 空状态：chapters/ 目录为空或不存在 -->
      <div v-if="!hasChapters" class="px-2 py-8 text-center">
        <p class="mb-1 text-sm text-gray-400">还没有章节</p>
        <p class="text-xs text-gray-500">在对话框输入指令，让 AI 开始第一章吧</p>
      </div>

      <!-- 章节列表：平铺渲染 chapters/ 直接子项 -->
      <ul v-else class="space-y-0.5">
        <li v-for="node in chapterNodes" :key="node.path">
          <!-- 目录节点（卷/部）：可折叠的分组标题 -->
          <button
            v-if="node.kind === 'directory'"
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
            @click="toggleDir(node.path)"
          >
            <svg
              :class="['h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform', isDirExpanded(node.path) ? 'rotate-90' : '']"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <svg class="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                v-if="isDirExpanded(node.path)"
                stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
              />
              <path
                v-else
                stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
            <span class="flex-1 truncate">{{ node.name }}</span>
            <span class="shrink-0 text-xs text-gray-500">{{ node.children?.length ?? 0 }}</span>
          </button>

          <!-- 目录展开后的子项 -->
          <ul
            v-if="node.kind === 'directory' && isDirExpanded(node.path) && node.children?.length"
            class="mb-1 ml-3 border-l border-white/10 pl-2"
          >
            <li v-for="child in node.children" :key="child.path">
              <button
                v-if="child.kind === 'file'"
                :class="[
                  'flex w-full items-center rounded-md px-2 py-1 text-left text-xs transition-colors',
                  child.path === activeFilePath
                    ? 'bg-white/15 text-white'
                    : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
                ]"
                @click="emit('selectFile', child.path)"
              >
                <span class="truncate">{{ child.name }}</span>
              </button>
            </li>
          </ul>

          <!-- 文件节点（章节）：直接渲染 -->
          <button
            v-if="node.kind === 'file'"
            :class="[
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              node.path === activeFilePath
                ? 'bg-white/15 text-white'
                : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
            ]"
            @click="emit('selectFile', node.path)"
          >
            <svg class="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span class="truncate">{{ node.name }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
