<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { previewElementExtraction, writeExtractedElements } from '@novai/core/services/element-service'
import type {
  ElementExtractionResultView,
  ElementWriteResultView,
  FileContentView,
} from '@novai/core/services/types'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

const props = defineProps<{
  isOpen: boolean
  projectId: string
  file: FileContentView | null
}>()

const emit = defineEmits<{
  close: []
  elementsWritten: [result: ElementWriteResultView]
}>()

const viewMode = ref<'preview' | 'raw'>('preview')
const extractionStatus = ref('尚未提取要素')
const extractionPreview = ref<ElementExtractionResultView | null>(null)
const elementWriteResult = ref<ElementWriteResultView | null>(null)
const isExtracting = ref(false)
const isWritingElements = ref(false)

const canExtractElements = computed(() => {
  return Boolean(
    props.file &&
    props.file.path.startsWith('chapters/') &&
    props.file.name.endsWith('.txt') &&
    props.file.content.trim(),
  )
})

const extractionCount = computed(() => {
  if (!extractionPreview.value) {
    return 0
  }

  return countExtractionItems(extractionPreview.value)
})

const extractedPaths = computed(() => {
  if (!elementWriteResult.value) {
    return []
  }

  return [
    ...elementWriteResult.value.created,
    ...elementWriteResult.value.updated,
  ]
})

watch(
  () => props.file?.path,
  () => {
    resetExtractionState()
  },
)

function toggleViewMode() {
  viewMode.value = viewMode.value === 'preview' ? 'raw' : 'preview'
}

function getLanguageLabel(format: string) {
  switch (format) {
    case 'markdown': return 'Markdown'
    case 'json': return 'JSON'
    default: return '文本'
  }
}

function shouldRenderMarkdown(format: string) {
  return format === 'markdown'
}

async function handlePreviewElements() {
  if (!props.file || !canExtractElements.value || isExtracting.value) {
    return
  }

  isExtracting.value = true
  extractionStatus.value = '正在提取要素...'
  elementWriteResult.value = null

  try {
    extractionPreview.value = await previewElementExtraction({
      chapterContent: props.file.content,
      chapterPath: props.file.path,
    })

    extractionStatus.value = extractionCount.value > 0
      ? `已提取 ${extractionCount.value} 个候选要素`
      : '未提取到可写入的要素'
  } catch (error) {
    extractionStatus.value = error instanceof Error ? error.message : '要素提取失败'
  } finally {
    isExtracting.value = false
  }
}

async function handleWriteElements() {
  if (!extractionPreview.value || isWritingElements.value) {
    return
  }

  isWritingElements.value = true
  extractionStatus.value = '正在写入要素文件...'

  try {
    elementWriteResult.value = await writeExtractedElements({
      projectId: props.projectId,
      extraction: extractionPreview.value,
    })

    const changedCount = elementWriteResult.value.created.length + elementWriteResult.value.updated.length
    extractionStatus.value = changedCount > 0
      ? `已写入 ${changedCount} 个要素文件`
      : `没有新的要素需要写入，跳过 ${elementWriteResult.value.skipped.length} 个文件`
    emit('elementsWritten', elementWriteResult.value)
  } catch (error) {
    extractionStatus.value = error instanceof Error ? error.message : '写入要素失败'
  } finally {
    isWritingElements.value = false
  }
}

function resetExtractionState() {
  extractionStatus.value = canExtractElements.value ? '尚未提取要素' : '当前文件不支持要素提取'
  extractionPreview.value = null
  elementWriteResult.value = null
  isExtracting.value = false
  isWritingElements.value = false
}

function countExtractionItems(result: ElementExtractionResultView) {
  return result.characters.length +
    result.locations.length +
    result.timeline.length +
    result.plots.length +
    result.worldbuilding.length
}
</script>

<template>
  <!-- 移动端遮罩 -->
  <div
    v-if="isOpen"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden"
    @click="emit('close')"
  />

  <!-- 内容面板 -->
  <aside
    :class="[
      'flex shrink-0 flex-col border-l border-gray-200 bg-white transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50',
      isOpen ? 'w-80' : 'w-0 overflow-hidden',
      isOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full',
    ]"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="truncate text-sm font-semibold text-gray-800">
          {{ file ? file.name : '内容预览' }}
        </h2>
        <span v-if="file" class="shrink-0 text-xs text-gray-500">
          {{ getLanguageLabel(file.format) }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <!-- 预览/原始切换 -->
        <button
          v-if="file"
          class="rounded-lg px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100"
          @click="toggleViewMode"
        >
          {{ viewMode === 'preview' ? '原始' : '预览' }}
        </button>
        <button
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:hidden"
          @click="emit('close')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-y-auto p-4">
      <!-- 空状态 -->
      <div v-if="!file" class="flex flex-col items-center justify-center py-16">
        <svg class="mb-4 h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="mb-1 text-sm font-medium text-gray-400">暂无内容</p>
        <p class="text-xs text-gray-400">点击文件或等待 AI 生成</p>
      </div>

      <!-- 文件内容 -->
      <div v-else-if="file" class="space-y-3">
        <!-- 章节要素提取 -->
        <div
          v-if="canExtractElements"
          class="space-y-3 rounded-lg border border-gray-200 bg-white p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold text-gray-800">故事要素</h3>
              <p class="mt-0.5 truncate text-xs text-gray-500">{{ extractionStatus }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <button
                class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40"
                :disabled="isExtracting || isWritingElements"
                title="提取要素"
                @click="handlePreviewElements"
              >
                <svg
                  v-if="isExtracting"
                  class="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.5 14.25v-7.5A2.25 2.25 0 0017.25 4.5H6.75A2.25 2.25 0 004.5 6.75v10.5A2.25 2.25 0 006.75 19.5h7.5m2.25-3v6m3-3h-6" />
                </svg>
              </button>
              <button
                class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40"
                :disabled="!extractionPreview || extractionCount === 0 || isExtracting || isWritingElements"
                title="写入 elements"
                @click="handleWriteElements"
              >
                <svg
                  v-if="isWritingElements"
                  class="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </button>
            </div>
          </div>

          <div
            v-if="extractionPreview"
            class="grid grid-cols-5 gap-1 text-center text-xs"
          >
            <div class="rounded-md bg-gray-50 px-1 py-1">
              <div class="font-semibold text-gray-800">{{ extractionPreview.characters.length }}</div>
              <div class="text-gray-500">人物</div>
            </div>
            <div class="rounded-md bg-gray-50 px-1 py-1">
              <div class="font-semibold text-gray-800">{{ extractionPreview.locations.length }}</div>
              <div class="text-gray-500">地点</div>
            </div>
            <div class="rounded-md bg-gray-50 px-1 py-1">
              <div class="font-semibold text-gray-800">{{ extractionPreview.plots.length }}</div>
              <div class="text-gray-500">情节</div>
            </div>
            <div class="rounded-md bg-gray-50 px-1 py-1">
              <div class="font-semibold text-gray-800">{{ extractionPreview.timeline.length }}</div>
              <div class="text-gray-500">时间</div>
            </div>
            <div class="rounded-md bg-gray-50 px-1 py-1">
              <div class="font-semibold text-gray-800">{{ extractionPreview.worldbuilding.length }}</div>
              <div class="text-gray-500">设定</div>
            </div>
          </div>

          <div
            v-if="extractedPaths.length > 0"
            class="space-y-1 border-t border-gray-100 pt-2"
          >
            <p class="text-xs font-medium text-gray-600">已写入</p>
            <p
              v-for="path in extractedPaths.slice(0, 4)"
              :key="path"
              class="truncate text-xs text-gray-500"
            >
              {{ path }}
            </p>
          </div>
        </div>

        <!-- 预览模式 -->
        <div v-if="viewMode === 'preview'" class="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <MarkdownRenderer v-if="shouldRenderMarkdown(file.format)" :content="file.content" />
          <pre v-else class="whitespace-pre-wrap text-sm text-gray-800">{{ file.content }}</pre>
        </div>

        <!-- 原始模式 -->
        <div v-else class="rounded-lg border border-gray-200 bg-gray-900 p-4">
          <pre class="whitespace-pre-wrap font-mono text-sm text-gray-100">{{ file.content }}</pre>
        </div>

        <!-- 文件信息 -->
        <div class="flex items-center justify-between text-xs text-gray-500">
          <span>{{ file.path }}</span>
          <span v-if="file.updatedAt">{{ new Date(file.updatedAt).toLocaleString('zh-CN') }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>
