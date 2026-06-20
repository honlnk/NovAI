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
const isModalOpen = ref(false)

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

function openModal() {
  isModalOpen.value = true
}

function closeModal() {
  isModalOpen.value = false
}

function handleCancel() {
  closeModal()
  emit('cancel')
}

function handleDismiss() {
  closeModal()
  emit('dismiss')
}
</script>

<template>
  <div class="absolute bottom-24 right-4 z-40 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg shadow-gray-900/10">
    <!-- 右下角状态提示 -->
    <div v-if="phase === 'extracting'">
      <div class="flex items-center gap-2">
        <svg class="h-4 w-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <p class="min-w-0 truncate text-sm font-medium text-gray-700">
          正在提取要素
          <span class="text-gray-400">[{{ progressCurrent }}/{{ progressTotal }}]</span>
          {{ progressChapterName }}
        </p>
      </div>
    </div>

    <div v-else-if="phase === 'preview' || phase === 'writing'">
      <div class="flex items-start gap-2">
        <svg class="mt-0.5 h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-700">已提取 {{ totalCandidates }} 个候选要素</p>
          <p class="mt-0.5 text-xs text-gray-500">{{ phase === 'writing' ? '正在写入 elements...' : '点击查看详情后确认写入' }}</p>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <button
          type="button"
          class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
          @click="openModal"
        >
          查看详情
        </button>
      </div>
    </div>

    <div v-else-if="phase === 'done' && writeResult">
      <div class="flex items-start gap-2">
        <svg class="mt-0.5 h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-700">要素写入完成</p>
          <p class="mt-0.5 text-xs text-gray-500">新增 {{ writeResult.created.length }} 个，更新 {{ writeResult.updated.length }} 个</p>
        </div>
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100" @click="openModal">
          查看
        </button>
        <button type="button" class="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800" @click="handleDismiss">
          关闭
        </button>
      </div>
    </div>

    <div v-else-if="phase === 'error'">
      <div class="flex items-start gap-2">
        <svg class="mt-0.5 h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-red-600">提取失败</p>
          <p class="mt-0.5 truncate text-xs text-gray-500">{{ errorMessage }}</p>
        </div>
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100" @click="openModal">
          查看
        </button>
        <button type="button" class="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800" @click="handleDismiss">
          关闭
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="isModalOpen"
        class="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/40 px-4 py-6"
        @click.self="closeModal"
      >
        <div class="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl">
          <div class="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <p class="text-base font-semibold text-gray-800">
                {{ phase === 'done' ? '要素写入结果' : phase === 'error' ? '提取失败' : '要素提取详情' }}
              </p>
              <p v-if="phase === 'preview' || phase === 'writing'" class="mt-0.5 text-xs text-gray-500">
                共 {{ totalCandidates }} 个候选要素
              </p>
            </div>
            <button
              type="button"
              class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              @click="closeModal"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div v-if="(phase === 'preview' || phase === 'writing') && extractionResult" class="space-y-3">
              <div v-for="bucket in BUCKETS" :key="bucket.key">
                <button
                  v-if="getItems(extractionResult, bucket.key).length > 0"
                  type="button"
                  class="flex w-full items-center gap-1.5 py-1.5 text-left text-sm font-medium text-gray-600"
                  @click="toggleGroup(bucket.key)"
                >
                  <span class="shrink-0">{{ bucket.icon }}</span>
                  <span>{{ bucket.label }}</span>
                  <span class="text-gray-400">({{ getItems(extractionResult, bucket.key).length }})</span>
                  <svg
                    class="ml-auto h-3.5 w-3.5 text-gray-400 transition-transform"
                    :class="{ 'rotate-180': expandedGroups.has(bucket.key) }"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <ul
                  v-if="expandedGroups.has(bucket.key) && getItems(extractionResult, bucket.key).length > 0"
                  class="ml-5 space-y-2 border-l border-gray-200 pl-3"
                >
                  <li v-for="item in getItems(extractionResult, bucket.key)" :key="item.name" class="py-0.5">
                    <p class="text-sm font-medium text-gray-700">{{ item.name }}</p>
                    <p v-if="item.summary" class="text-xs leading-5 text-gray-500">{{ item.summary }}</p>
                  </li>
                </ul>
              </div>
            </div>

            <div v-else-if="phase === 'done' && writeResult" class="space-y-1 text-sm text-gray-600">
              <p>新增 {{ writeResult.created.length }} 个</p>
              <p>更新 {{ writeResult.updated.length }} 个</p>
              <p v-if="writeResult.skipped.length > 0">跳过 {{ writeResult.skipped.length }} 个（无变化）</p>
              <p v-if="writeResult.staleIndex" class="mt-2 text-amber-600">RAG 索引已标记为过期，可在设置中重建。</p>
            </div>

            <div v-else-if="phase === 'error'" class="text-sm text-gray-600">
              <p>{{ errorMessage }}</p>
              <p class="mt-2 text-xs text-gray-400">请检查设置页的 LLM 配置是否正确。</p>
            </div>
          </div>

          <div
            v-if="phase === 'preview' || phase === 'writing'"
            class="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-4"
          >
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
              :disabled="isWriting"
              @click="handleCancel"
            >
              取消
            </button>
            <button
              type="button"
              class="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isWriting"
              @click="emit('confirm')"
            >
              {{ isWriting ? '写入中...' : '确认写入' }}
            </button>
          </div>

          <div v-else class="flex items-center justify-end border-t border-gray-100 px-5 py-4">
            <button
              type="button"
              class="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800"
              @click="handleDismiss"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
