<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'

/**
 * 章节多选弹层（R6）。
 *
 * 输入框输入 /提取要素 后触发，供用户多选要提取要素的章节。
 * 与 SceneCommandPopover（单选）交互差异大，独立组件。
 */
const props = defineProps<{
  /** 章节列表（chapters/*.txt|.md，已扁平化） */
  chapters: ProjectFileNodeView[]
}>()

const emit = defineEmits<{
  /** 确认提取，返回选中章节的 path+name */
  confirm: [chapters: { path: string; name: string }[]]
  /** 取消 */
  cancel: []
}>()

const searchQuery = ref('')
const selectedPaths = ref<Set<string>>(new Set())

/** 按搜索词过滤章节名（不区分大小写） */
const filteredChapters = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.chapters
  return props.chapters.filter((c) => c.name.toLowerCase().includes(q))
})

const selectedCount = computed(() => selectedPaths.value.size)

function toggleChapter(path: string) {
  const next = new Set(selectedPaths.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  selectedPaths.value = next
}

function handleConfirm() {
  const picked = props.chapters
    .filter((c) => selectedPaths.value.has(c.path))
    .map((c) => ({ path: c.path, name: c.name }))
  if (picked.length === 0) return
  emit('confirm', picked)
  // 重置选择
  selectedPaths.value = new Set()
  searchQuery.value = ''
}

function handleCancel() {
  emit('cancel')
  selectedPaths.value = new Set()
  searchQuery.value = ''
}
</script>

<template>
  <div
    class="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(400px,58vh)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-gray-900/10 ring-1 ring-gray-900/5"
  >
    <!-- 搜索框 -->
    <div class="border-b border-gray-100 px-4 py-3">
      <p class="mb-2 text-xs font-semibold text-gray-400">选择章节</p>
      <input
        v-model="searchQuery"
        type="text"
        class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-800 placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100"
        placeholder="筛选章节..."
        autofocus
      />
    </div>

    <!-- 章节列表 -->
    <ul v-if="filteredChapters.length > 0" class="max-h-64 overflow-y-auto px-1.5 py-1.5">
      <li v-for="chapter in filteredChapters" :key="chapter.path">
        <button
          type="button"
          :class="[
            'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
            selectedPaths.has(chapter.path) ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="toggleChapter(chapter.path)"
        >
          <span
            :class="[
              'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
              selectedPaths.has(chapter.path)
                ? 'border-blue-400 bg-blue-500 text-white'
                : 'border-gray-300 bg-white',
            ]"
          >
            <svg v-if="selectedPaths.has(chapter.path)" class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <span class="flex-1 truncate text-sm font-semibold leading-5">{{ chapter.name }}</span>
        </button>
      </li>
    </ul>
    <div v-else class="px-4 py-6 text-center text-xs font-medium text-gray-400">
      {{ chapters.length === 0 ? '暂无章节' : '没有匹配的章节' }}
    </div>

    <!-- 底部操作 -->
    <div class="flex items-center justify-between gap-3 border-t border-gray-100 px-4 py-3">
      <div class="flex items-center gap-2.5 text-xs font-semibold text-gray-400">
        <span class="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] text-gray-500">i</span>
        <span>{{ selectedCount > 0 ? `已选择 ${selectedCount} 个章节` : '选择要提取要素的章节' }}</span>
      </div>
      <div class="flex items-center gap-2">
      <button
        type="button"
        class="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800"
        @click="handleCancel"
      >
        取消
      </button>
      <button
        type="button"
        class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
        :disabled="selectedCount === 0"
        @click="handleConfirm"
      >
        确认提取{{ selectedCount > 0 ? `(${selectedCount})` : '' }}
      </button>
      </div>
    </div>
  </div>
</template>
