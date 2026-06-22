<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { ELEMENT_CATEGORIES } from '../../constants/elements'
import { collectFilesByPrefix } from '../../utils/file-tree'

const props = defineProps<{
  files: ProjectFileNodeView[]
  activeFilePath?: string
}>()

const emit = defineEmits<{
  selectFile: [path: string]
}>()

/**
 * 每个分组目录下递归收集到的文件（扁平列表，不含目录）。
 * 按 directory 前缀深入收集，所以 elements/characters/ 下无论嵌套多深都能取到。
 */
function filesOf(directory: string): ProjectFileNodeView[] {
  return collectFilesByPrefix(props.files, directory)
}

/** 预计算每个分组的文件数，标题右侧展示 */
const counts = computed(() => {
  const map = new Map<string, number>()
  for (const category of ELEMENT_CATEGORIES) {
    map.set(category.key, filesOf(category.directory).length)
  }
  return map
})

/** 总文件数：用于判断是否所有分组都为空（控制整体空状态是否展示） */
const totalCount = computed(() => {
  let sum = 0
  for (const count of counts.value.values()) {
    sum += count
  }
  return sum
})

/**
 * 每个分组的展开状态。
 * key = category.key，默认全部折叠。
 */
const expandedKeys = ref<Set<string>>(new Set())

function toggleGroup(key: string) {
  if (expandedKeys.value.has(key)) {
    expandedKeys.value.delete(key)
  } else {
    expandedKeys.value.add(key)
  }
}

function isExpanded(key: string) {
  return expandedKeys.value.has(key)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="px-4 py-3">
      <h2 class="text-sm font-semibold text-white">要素</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 6 个分组始终展示（这是固定的分类结构，不因内容为空而隐藏） -->
      <div class="space-y-0.5">
        <div v-for="category in ELEMENT_CATEGORIES" :key="category.key">
          <!-- 分组标题 -->
          <button
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
            @click="toggleGroup(category.key)"
          >
            <svg
              :class="['h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform', isExpanded(category.key) ? 'rotate-90' : '']"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <span class="shrink-0 text-sm">{{ category.icon }}</span>
            <span class="flex-1 truncate">{{ category.label }}</span>
            <span class="shrink-0 text-xs text-gray-500">{{ counts.get(category.key) ?? 0 }}</span>
          </button>

          <!-- 分组文件（展开时） -->
          <ul
            v-if="isExpanded(category.key)"
            class="mb-1 ml-3 border-l border-white/10 pl-2"
          >
            <li v-for="node in filesOf(category.directory)" :key="node.path">
              <button
                :class="[
                  'flex w-full items-center rounded-md px-2 py-1 text-left text-xs transition-colors',
                  node.path === activeFilePath
                    ? 'bg-white/15 text-white'
                    : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
                ]"
                @click="emit('selectFile', node.path)"
              >
                <span class="truncate">{{ node.name }}</span>
              </button>
            </li>
            <!-- 仅在该分组展开且为空时显示组内空状态 -->
            <li v-if="filesOf(category.directory).length === 0">
              <p class="px-2 py-1 text-xs text-gray-600">暂无</p>
            </li>
          </ul>
        </div>
      </div>

      <!--
        不再展示整体空状态。
        6 个分组是项目的固定分类结构，默认折叠时本身就只显示标题行，
        没有内容时让用户看到 6 个分组标题比显示「还没有要素」更符合预期。
      -->
      <p v-if="totalCount === 0" class="mt-3 px-2 pb-1 text-xs text-gray-600">
        所有分组暂无要素文件
      </p>
    </div>
  </div>
</template>
