<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FileContentView } from '@novai/core/services/types'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import Tooltip from '../ui/Tooltip.vue'
import ResizeHandle from './ResizeHandle.vue'

const props = defineProps<{
  isOpen: boolean
  projectId: string
  file: FileContentView | null
  /** 内容面板宽度（px），由 ProjectView 持有并持久化（R7） */
  width: number
}>()

const emit = defineEmits<{
  close: []
  save: [path: string, content: string]
  selectQuote: [payload: { path: string; name: string; text: string }]
  /** 拖拽改宽：发出 clamp 后的目标宽度（R7） */
  resize: [width: number]
  /** 双击手柄重置到默认宽度（R7） */
  'reset-width': []
}>()

const viewMode = ref<'preview' | 'edit' | 'raw'>('preview')
const editDraft = ref('')
const isSaving = ref(false)
/** 拖拽改宽进行中（R7）：暂停 aside 过渡动画，避免宽度变化滞后于光标 */
const isResizing = ref(false)

const canEdit = computed(() => {
  return Boolean(props.file && isEditablePath(props.file.path))
})

/** 草稿与磁盘内容不一致时为脏，用于显示「未保存」标记 */
const isDirty = computed(() => editDraft.value !== (props.file?.content ?? ''))

watch(
  () => props.file?.path,
  () => {
    // 切换文件时回到预览模式并重置草稿，避免跨文件残留编辑内容
    viewMode.value = 'preview'
    editDraft.value = ''
  },
)

// 进入编辑模式时，以磁盘当前内容初始化草稿
watch(viewMode, (mode) => {
  if (mode === 'edit') {
    editDraft.value = props.file?.content ?? ''
  }
})

/**
 * 可编辑范围（D7 决策）：章节、提示词、要素 .md。
 * .novel 配置、原始 JSON 等不进入用户编辑视图。
 */
function isEditablePath(path: string): boolean {
  return path.startsWith('chapters/') ||
    path.startsWith('prompts/') ||
    (path.startsWith('elements/') && /\.md$/i.test(path))
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

/**
 * 编辑模式键盘处理：Ctrl/Cmd+S 手动保存（失焦不自动保存）。
 */
function handleKeydown(event: KeyboardEvent) {
  const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key === 's'
  if (isSaveShortcut) {
    event.preventDefault()
    void handleSave()
  }
}

async function handleSave() {
  if (!props.file || !canEdit.value || isSaving.value || !isDirty.value) {
    return
  }

  isSaving.value = true
  try {
    emit('save', props.file.path, editDraft.value)
  } finally {
    isSaving.value = false
  }
}

/**
 * 拖拽改宽（R7）：手柄发出目标宽度，clamp 到 240~720 后上抛。
 */
function handleResize(width: number) {
  emit('resize', Math.max(240, Math.min(720, width)))
}

/**
 * 预览模式下捕获用户选中的文本，生成引用 chip。
 * 仅预览模式触发（编辑模式选中是编辑操作，原始模式选中无意义）。
 * 单段上限 500 字符，超出截断（避免整篇复制）。
 */
function handleContentMouseup() {
  if (!props.file || viewMode.value !== 'preview') return

  const selection = window.getSelection()
  const text = selection?.toString().trim() ?? ''
  if (text.length === 0) return

  const trimmed = text.length > 500 ? `${text.slice(0, 500)}…` : text
  emit('selectQuote', {
    path: props.file.path,
    name: props.file.name,
    text: trimmed,
  })
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
      'relative flex shrink-0 flex-col border-l border-gray-200 bg-white',
      isResizing ? '' : 'transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50',
      isOpen ? '' : 'w-0 overflow-hidden',
      isOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full',
    ]"
    :style="isOpen ? { width: width + 'px' } : undefined"
  >
    <!-- 拖拽改宽手柄（仅 lg: 以上显示，R7） -->
    <ResizeHandle
      :start-width="width"
      @dragstart="isResizing = true"
      @drag="handleResize"
      @dragend="isResizing = false"
      @reset="emit('reset-width')"
    />

    <!-- 头部 -->
    <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="truncate text-sm font-semibold text-gray-800">
          {{ file ? file.name : '内容预览' }}
        </h2>
        <!-- 未保存标记 -->
        <span
          v-if="file && viewMode === 'edit' && isDirty"
          class="flex shrink-0 items-center gap-1 text-xs text-amber-600"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-amber-500" />
          未保存
        </span>
        <span v-if="file" class="shrink-0 text-xs text-gray-500">
          {{ getLanguageLabel(file.format) }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <!-- 预览/编辑/原始 三态分段控件 -->
        <div
          v-if="file"
          class="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5"
        >
          <Tooltip
            v-for="mode in [
              { key: 'preview', label: '预览', icon: 'eye' },
              { key: 'edit', label: '编辑', icon: 'pencil' },
              { key: 'raw', label: '原始', icon: 'code' },
            ]"
            :key="mode.key"
            :text="mode.key === 'edit' && !canEdit ? `${mode.label}（该文件类型不支持编辑）` : mode.label"
            :disabled="mode.key === 'edit' && !canEdit"
            :delay="300"
            preferred-placement="bottom"
          >
            <button
              :class="[
                'flex items-center justify-center rounded-md p-1.5 transition-colors',
                viewMode === mode.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
                mode.key === 'edit' && !canEdit ? 'cursor-not-allowed opacity-40' : '',
              ]"
              :disabled="mode.key === 'edit' && !canEdit"
              @click="viewMode = mode.key as typeof viewMode"
            >
              <!-- 预览（眼睛） -->
              <svg v-if="mode.icon === 'eye'" class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <!-- 编辑（铅笔） -->
              <svg v-else-if="mode.icon === 'pencil'" class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <!-- 原始（代码括号） -->
              <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25" />
              </svg>
            </button>
          </Tooltip>
        </div>
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
        <!-- 预览模式 -->
        <div
          v-if="viewMode === 'preview'"
          class="rounded-lg border border-gray-200 bg-gray-50 p-4"
          @mouseup="handleContentMouseup"
        >
          <MarkdownRenderer v-if="shouldRenderMarkdown(file.format)" :content="file.content" />
          <pre v-else class="whitespace-pre-wrap text-sm text-gray-800">{{ file.content }}</pre>
        </div>

        <!-- 编辑模式 -->
        <div v-else-if="viewMode === 'edit'" class="flex flex-col rounded-lg border border-gray-200 bg-white p-2">
          <textarea
            v-model="editDraft"
            :disabled="!canEdit"
            class="min-h-[400px] w-full resize-none rounded-md border border-gray-200 p-3 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
            placeholder="该文件类型不支持编辑"
            @keydown="handleKeydown"
          />
          <div class="mt-2 flex items-center justify-between px-1">
            <span class="text-xs text-gray-400">Ctrl/⌘ + S 保存</span>
            <button
              type="button"
              class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
              :disabled="!canEdit || !isDirty || isSaving"
              @click="handleSave"
            >
              {{ isSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <!-- 原始模式 -->
        <div v-else-if="viewMode === 'raw'" class="rounded-lg border border-gray-200 bg-gray-900 p-4">
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
