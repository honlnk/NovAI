<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  ElementExtractionItemView,
  ElementExtractionResultView,
  ElementWriteResultView,
} from '@novai/core/services/types'
import type { ExtractionPhase } from '../../composables/useElementExtraction'
import { countExtractionItems } from '../../composables/useElementExtraction'

/**
 * 要素提取流程面板（R6）。
 *
 * 按 phase 渲染：提取中（进度）→ 预览（候选分组+确认/取消）→ 完成（写入统计）→ 错误。
 * 数据由父组件从 useElementExtraction composable 传入。
 */
const props = defineProps<{
  phase: ExtractionPhase
  extractionResult: ElementExtractionResultView | null
  writeResult: ElementWriteResultView | null
  progressCurrent: number
  progressTotal: number
  progressChapterName: string
  errorMessage: string
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
  dismiss: []
}>()

const isWriting = computed(() => props.phase === 'writing')

const totalCandidates = computed(() =>
  props.extractionResult ? countExtractionItems(props.extractionResult) : 0,
)

/** 六类配置：key + 中文名 + 图标 */
const BUCKETS = [
  { key: 'characters' as const, label: '人物', icon: '👤' },
  { key: 'locations' as const, label: '地点', icon: '📍' },
  { key: 'entities' as const, label: '实体', icon: '📦' },
  { key: 'timeline' as const, label: '时间线', icon: '⏰' },
  { key: 'plots' as const, label: '剧情', icon: '📖' },
  { key: 'worldbuilding' as const, label: '世界观', icon: '🌍' },
]

/** 展开的分组（默认全部展开） */
const expandedGroups = ref<Set<string>>(new Set(BUCKETS.map((b) => b.key)))

function toggleGroup(key: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedGroups.value = next
}

function getItems(result: ElementExtractionResultView, key: keyof ElementExtractionResultView): ElementExtractionItemView[] {
  return result[key] as ElementExtractionItemView[]
}

const progressPercent = computed(() => {
  if (props.progressTotal === 0) return 0
  return Math.round((props.progressCurrent / props.progressTotal) * 100)
})
</script>

<template>
  <div class="mx-auto mb-2 max-w-3xl rounded-lg border border-gray-200 bg-gray-50">
    <!-- 提取中 -->
    <div v-if="phase === 'extracting'" class="p-4">
      <div class="mb-2 flex items-center gap-2">
        <svg class="h-4 w-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <p class="text-sm font-medium text-gray-700">
          正在提取要素（{{ progressCurrent }}/{{ progressTotal }}）
        </p>
      </div>
      <p class="mb-2 truncate text-xs text-gray-500">{{ progressChapterName }}</p>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          class="h-full bg-blue-500 transition-all duration-300"
          :style="{ width: progressPercent + '%' }"
        />
      </div>
    </div>

    <!-- 预览候选 -->
    <div v-else-if="phase === 'preview' || phase === 'writing'" class="p-4">
      <div class="mb-3 flex items-center justify-between">
        <p class="text-sm font-medium text-gray-700">
          已提取 {{ totalCandidates }} 个候选要素
        </p>
        <span v-if="phase === 'writing'" class="text-xs text-gray-400">写入中...</span>
      </div>

      <div v-if="extractionResult" class="space-y-2">
        <div v-for="bucket in BUCKETS" :key="bucket.key">
          <button
            v-if="getItems(extractionResult, bucket.key).length > 0"
            type="button"
            class="flex w-full items-center gap-1.5 py-1 text-left text-xs font-medium text-gray-600"
            @click="toggleGroup(bucket.key)"
          >
            <span class="shrink-0">{{ bucket.icon }}</span>
            <span>{{ bucket.label }}</span>
            <span class="text-gray-400">({{ getItems(extractionResult, bucket.key).length }})</span>
            <svg
              class="ml-auto h-3 w-3 text-gray-400 transition-transform"
              :class="{ 'rotate-180': expandedGroups.has(bucket.key) }"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <ul
            v-if="expandedGroups.has(bucket.key) && getItems(extractionResult, bucket.key).length > 0"
            class="ml-5 space-y-1 border-l border-gray-200 pl-3"
          >
            <li
              v-for="item in getItems(extractionResult, bucket.key)"
              :key="item.name"
              class="py-0.5"
            >
              <p class="text-xs font-medium text-gray-700">{{ item.name }}</p>
              <p v-if="item.summary" class="truncate text-xs text-gray-500">{{ item.summary }}</p>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="phase === 'preview'" class="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          type="button"
          class="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700"
          @click="emit('confirm')"
        >
          确认写入
        </button>
      </div>
    </div>

    <!-- 写入完成 -->
    <div v-else-if="phase === 'done' && writeResult" class="p-4">
      <div class="mb-2 flex items-center gap-2">
        <svg class="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <p class="text-sm font-medium text-gray-700">要素写入完成</p>
      </div>
      <div class="ml-6 space-y-0.5 text-xs text-gray-500">
        <p>✅ 新增 {{ writeResult.created.length }} 个</p>
        <p>🔄 更新 {{ writeResult.updated.length }} 个</p>
        <p v-if="writeResult.skipped.length > 0">⏭️ 跳过 {{ writeResult.skipped.length }} 个（无变化）</p>
        <p v-if="writeResult.staleIndex" class="mt-1 text-amber-600">⚠️ RAG 索引已标记为过期，可在设置中重建</p>
      </div>
      <div class="mt-3 flex justify-end">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200"
          @click="emit('dismiss')"
        >
          关闭
        </button>
      </div>
    </div>

    <!-- 错误 -->
    <div v-else-if="phase === 'error'" class="p-4">
      <div class="mb-2 flex items-center gap-2">
        <svg class="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
        </svg>
        <p class="text-sm font-medium text-red-600">提取失败</p>
      </div>
      <p class="ml-6 text-xs text-gray-500">{{ errorMessage }}</p>
      <p class="ml-6 mt-1 text-xs text-gray-400">请检查设置页的 LLM 配置是否正确。</p>
      <div class="mt-3 flex justify-end">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200"
          @click="emit('dismiss')"
        >
          关闭
        </button>
      </div>
    </div>
  </div>
</template>
