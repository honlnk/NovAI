<script setup lang="ts">
import type { Category } from '../../constants/category'

defineProps<{
  activeCategory: Category
}>()

const emit = defineEmits<{
  select: [category: Category]
  openSettings: []
  backToHome: []
  /** 功能占位项：暂未实现，仅保留入口 */
  proofread: []
  organize: []
  version: []
}>()

/**
 * 顶部分类项（设置走单独的 openSettings，不在此列）。
 * 顺序按产品决策：对话 → 章节 → 要素 → 提示词。
 */
const categoryItems: { key: Category; label: string; icon: string }[] = [
  { key: 'conversation', label: '对话', icon: 'chat' },
  { key: 'chapter', label: '章节', icon: 'book' },
  { key: 'element', label: '要素', icon: 'tag' },
  { key: 'prompt', label: '提示词', icon: 'note' },
]

/**
 * 底部功能占位项（暂未实现）。
 * 仅保留入口，点击触发对应 emit，由 ProjectView 决定如何反馈。
 * 顺序对应原 FileTreeSidebar 底部：校对 → 章节整理 → 版本管理。
 */
const actionItems: { key: 'proofread' | 'organize' | 'version'; label: string; icon: string }[] = [
  { key: 'proofread', label: '校对', icon: 'check' },
  { key: 'organize', label: '章节整理', icon: 'list' },
  { key: 'version', label: '版本管理', icon: 'branch' },
]

/**
 * 模板里不能直接动态调 emit（联合类型无法匹配 emit 重载），
 * 在 script 里集中分发。
 */
function emitAction(key: 'proofread' | 'organize' | 'version') {
  switch (key) {
    case 'proofread': emit('proofread'); break
    case 'organize': emit('organize'); break
    case 'version': emit('version'); break
  }
}
</script>

<template>
  <nav class="flex w-14 shrink-0 flex-col items-center justify-between border-r border-white/10 bg-[#171717] py-2">
    <!-- 顶部分类图标 -->
    <div class="flex flex-col items-center gap-1">
      <button
        v-for="item in categoryItems"
        :key="item.key"
        :title="item.label"
        :class="[
          'group flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
          activeCategory === item.key
            ? 'bg-white/15 text-white'
            : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
        ]"
        @click="emit('select', item.key)"
      >
        <!-- 对话 -->
        <svg v-if="item.icon === 'chat'" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <!-- 章节 -->
        <svg v-else-if="item.icon === 'book'" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
        <!-- 要素 -->
        <svg v-else-if="item.icon === 'tag'" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
        <!-- 提示词 -->
        <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      </button>
    </div>

    <!-- 底部动作项：功能占位 + 设置 + 返回首页 -->
    <div class="flex flex-col items-center gap-1">
      <!-- 功能占位项（暂未实现，灰一档提示） -->
      <button
        v-for="item in actionItems"
        :key="item.key"
        :title="`${item.label}（即将推出）`"
        class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-white/10 hover:text-gray-400"
        @click="emitAction(item.key)"
      >
        <!-- 校对 -->
        <svg v-if="item.icon === 'check'" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <!-- 章节整理 -->
        <svg v-else-if="item.icon === 'list'" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        <!-- 版本管理 -->
        <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      </button>

      <!-- 分隔线 -->
      <div class="my-1 h-px w-6 bg-white/10" />

      <button
        title="设置"
        class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
        @click="emit('openSettings')"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      <button
        title="返回首页"
        class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
        @click="emit('backToHome')"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      </button>
    </div>
  </nav>
</template>
