<script setup lang="ts">
import type { ProjectView } from '@novai/core'

defineProps<{
  isOpen: boolean
  isMobileOpen: boolean
  project: ProjectView | null
}>()

const emit = defineEmits<{
  backToHome: []
  openSettings: []
  closeMobile: []
}>()

// 示例文件树数据（后续从 fileService 获取）
const sampleFileTree = [
  {
    name: 'chapters',
    type: 'directory' as const,
    children: [
      { name: '第001章-初入江湖.md', type: 'file' as const },
      { name: '第002章-遇险.md', type: 'file' as const },
    ],
  },
  {
    name: 'elements',
    type: 'directory' as const,
    children: [
      { name: 'characters', type: 'directory' as const, children: [] },
      { name: 'locations', type: 'directory' as const, children: [] },
    ],
  },
  {
    name: 'prompts',
    type: 'directory' as const,
    children: [
      { name: 'system.md', type: 'file' as const },
    ],
  },
]
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
      <div v-else class="space-y-0.5">
        <template v-for="item in sampleFileTree" :key="item.name">
          <!-- 目录 -->
          <div v-if="item.type === 'directory'">
            <button class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-300 transition-colors hover:bg-white/10">
              <svg class="h-3.5 w-3.5 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <svg class="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span class="truncate">{{ item.name }}</span>
            </button>
            <!-- 子文件（简化版，后续实现递归） -->
            <div v-if="item.children" class="ml-4">
              <button
                v-for="child in item.children"
                :key="child.name"
                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
              >
                <svg v-if="child.type === 'file'" class="h-4 w-4 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <svg v-else class="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span class="truncate">{{ child.name }}</span>
              </button>
            </div>
          </div>

          <!-- 文件 -->
          <button
            v-else
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
          >
            <svg class="h-4 w-4 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span class="truncate">{{ item.name }}</span>
          </button>
        </template>
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
