<script setup lang="ts">
import type { ProjectFileNodeView, ProjectView } from '@novai/core/services/types'
import TreeNode from '../file-tree/TreeNode.vue'

defineProps<{
  isOpen: boolean
  isMobileOpen: boolean
  project: ProjectView | null
  activeFilePath?: string
}>()

const emit = defineEmits<{
  backToHome: []
  openSettings: []
  closeMobile: []
  selectFile: [path: string]
  refreshTree: []
}>()
</script>

<template>
  <aside
    :class="[
      'flex w-64 shrink-0 flex-col bg-[#171717] text-gray-100 transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50',
      isOpen ? 'w-64' : 'w-0 overflow-hidden',
      isMobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
    ]"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-white">文件</h2>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
          title="返回首页"
          @click="emit('backToHome')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </button>
        <button
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
          title="设置"
          @click="emit('openSettings')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
          @click="emit('closeMobile')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 项目名称 -->
    <div v-if="project" class="border-b border-white/10 px-4 py-2">
      <p class="truncate text-xs text-gray-400">{{ project.name }}</p>
    </div>

    <!-- 文件树 -->
    <nav class="flex-1 overflow-y-auto px-2 py-2">
      <div v-if="!project" class="px-2 py-4 text-center text-sm text-gray-500">
        未打开项目
      </div>
      <div v-else-if="project.files.length === 0" class="px-2 py-4 text-center text-sm text-gray-500">
        项目为空
      </div>
      <div v-else class="space-y-0.5">
        <TreeNode
          v-for="node in project.files"
          :key="node.path"
          :node="node"
          :level="0"
          :active-file-path="activeFilePath"
          @select-file="emit('selectFile', $event)"
        />
      </div>
    </nav>

    <!-- 底部功能入口 -->
    <div class="border-t border-white/10 px-2 py-2">
      <button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        校对
      </button>
      <button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        章节整理
      </button>
      <button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
        版本管理
      </button>
    </div>
  </aside>
</template>
