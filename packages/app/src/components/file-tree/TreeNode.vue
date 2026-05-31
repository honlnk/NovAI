<script setup lang="ts">
import { ref } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'

const props = defineProps<{
  node: ProjectFileNodeView
  level: number
  activeFilePath?: string
}>()

const emit = defineEmits<{
  selectFile: [path: string]
}>()

const isExpanded = ref(props.level === 0)

function toggleExpand() {
  if (props.node.kind === 'directory') {
    isExpanded.value = !isExpanded.value
  }
}

function handleClick() {
  if (props.node.kind === 'file') {
    emit('selectFile', props.node.path)
  } else {
    toggleExpand()
  }
}

function getFileIcon(name: string) {
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.json')) return 'json'
  return 'file'
}
</script>

<template>
  <div>
    <button
      :class="[
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors',
        node.kind === 'file' && node.path === activeFilePath
          ? 'bg-white/15 text-white'
          : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
      ]"
      :style="{ paddingLeft: `${level * 12 + 8}px` }"
      @click="handleClick"
    >
      <!-- 展开/折叠箭头（仅目录） -->
      <svg
        v-if="node.kind === 'directory'"
        :class="[
          'h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform',
          isExpanded ? 'rotate-90' : '',
        ]"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      <span v-else class="w-3.5" />

      <!-- 图标 -->
      <svg
        v-if="node.kind === 'directory'"
        class="h-4 w-4 shrink-0 text-gray-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          v-if="isExpanded"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
        />
        <path
          v-else
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
        />
      </svg>
      <svg
        v-else-if="getFileIcon(node.name) === 'markdown'"
        class="h-4 w-4 shrink-0 text-blue-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <svg
        v-else-if="getFileIcon(node.name) === 'json'"
        class="h-4 w-4 shrink-0 text-yellow-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <svg
        v-else
        class="h-4 w-4 shrink-0 text-gray-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>

      <!-- 文件名 -->
      <span class="truncate">{{ node.name }}</span>
    </button>

    <!-- 子节点（递归渲染） -->
    <div v-if="node.kind === 'directory' && isExpanded && node.children?.length">
      <TreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :level="level + 1"
        :active-file-path="activeFilePath"
        @select-file="emit('selectFile', $event)"
      />
    </div>
  </div>
</template>
