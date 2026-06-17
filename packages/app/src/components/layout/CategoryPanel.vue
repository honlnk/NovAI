<script setup lang="ts">
import type { ProjectFileNodeView } from '@novai/core/services/types'
import type { Category } from '../../constants/category'
import ChapterList from '../category/ChapterList.vue'
import ElementList from '../category/ElementList.vue'
import PromptList from '../category/PromptList.vue'
import ConversationList from '../category/ConversationList.vue'

defineProps<{
  activeCategory: Category
  files: ProjectFileNodeView[]
  activeFilePath?: string
  activeScenePromptPath: string | null
  /** 移动端抽屉是否展开（沿用现有响应式方案） */
  isMobileOpen: boolean
  /** 面板是否展开（桌面端折叠/展开） */
  isOpen: boolean
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  changeScene: [path: string | null]
  closeMobile: []
}>()
</script>

<template>
  <aside
    :class="[
      'flex shrink-0 flex-col bg-[#171717] text-gray-100 transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:left-[56px] max-lg:z-50',
      isOpen ? 'w-64' : 'w-0 overflow-hidden',
      isMobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
    ]"
  >
    <!-- 移动端关闭按钮 -->
    <button
      class="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
      @click="emit('closeMobile')"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>

    <!-- 按分类切换内容 -->
    <ConversationList v-if="activeCategory === 'conversation'" />
    <ChapterList
      v-else-if="activeCategory === 'chapter'"
      :files="files"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
    />
    <ElementList
      v-else-if="activeCategory === 'element'"
      :files="files"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
    />
    <PromptList
      v-else-if="activeCategory === 'prompt'"
      :files="files"
      :active-file-path="activeFilePath"
      :active-scene-prompt-path="activeScenePromptPath"
      @select-file="emit('selectFile', $event)"
      @change-scene="emit('changeScene', $event)"
    />
  </aside>
</template>
