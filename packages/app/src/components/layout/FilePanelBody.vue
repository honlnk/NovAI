<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { FileContentView } from '@novai/core/services/types'
import { countContentChars } from '@novai/core'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import Tooltip from '../ui/Tooltip.vue'
import PanelHeader from './PanelHeader.vue'
import type { SaveFileOutcome } from '../../stores/project'
import { clearFileDraft, getFileDraft, setFileDraft } from '../../composables/useFileDrafts'
import {
  buildTextHighlightSegments,
  markdownBlockIndicesInRange,
  useChangeHighlights,
  type ChangeNotice,
} from '../../composables/useChangeHighlights'
import { parseMarkdownBlocks } from '../../utils/markdown-blocks'

/**
 * 普通文件内容（右侧面板的文件内容类型）：由旧 ContentPanel 原样迁出，
 * 预览/编辑两态、引用选中与草稿行为保持不变（布局统一计划只迁移位置归属）。
 * 内容卡片撑满面板剩余高度（与计划详情一致），滚动发生在卡片内部。
 *
 * 保存状态机（交互优化计划 §6）：保存等待真实写盘结果，失败/版本冲突保留草稿
 * 与编辑位置；字数统计当前阅读版本（编辑模式含未保存草稿）。
 * 草稿按路径保留在草稿表（useFileDrafts）：切换文件不静默丢失，回来即恢复。
 *
 * 定位高亮（交互优化计划 §7）：AI 写盘后按账本坐标在预览中定位——新内容绿显、
 * 被替换原文以相邻红段呈现（比较用，不写盘）；多处修改逐处切换，淡出后保留
 * 「重新查看本轮差异」；不抢现场时以变更通知队列呈现（可点击查看）。
 */
const props = defineProps<{
  file: FileContentView | null
  /** 草稿表与保存调用的项目归属 */
  projectId: string
  /** 空态提示（AI 删除了正打开的文件时由 ProjectView 置入，指向回收站去向） */
  notice?: { name: string; trashPath?: string } | null
  /** 保存处理器（ProjectView 注入 projectStore.saveFile）；面板据此驱动保存状态 */
  saveFile: (path: string, content: string, options?: { expectedUpdatedAt?: string; force?: boolean }) => Promise<SaveFileOutcome>
  /** 变更通知「查看差异」请求令牌：ProjectView 每次处理通知点击时递增（路径未变时也要切回预览） */
  locateToken?: number
}>()

const emit = defineEmits<{
  close: []
  /** 冲突时「读取最新（放弃草稿）」：ProjectView 重读磁盘内容 */
  reload: [path: string]
  selectQuote: [payload: { path: string; name: string; text: string }]
  /** 点击变更通知：ProjectView 打开对应文件并（可定位时）重播稳定差异 */
  locateChange: [notice: ChangeNotice]
}>()

const hl = useChangeHighlights(props.projectId)

const viewMode = ref<'preview' | 'edit'>('preview')
const editDraft = ref('')
/** 保存过程态：idle 回落为已保存/未保存二态（isDirty），error 保留原因与动作 */
const saveState = ref<'idle' | 'saving' | 'error'>('idle')
const saveError = ref<{ message: string; conflict: boolean; diskUpdatedAt?: string } | null>(null)

const canEdit = computed(() => {
  return Boolean(props.file && isEditablePath(props.file.path))
})

/** 草稿与磁盘内容不一致时为脏，用于显示「未保存」标记 */
const isDirty = computed(() => editDraft.value !== (props.file?.content ?? ''))

/** 稿件字数（§6）：统计当前阅读版本，编辑模式含未保存草稿；JSON 非稿件不统计 */
const wordCount = computed(() => {
  if (!props.file || props.file.format === 'json') {
    return null
  }
  const text = viewMode.value === 'edit' ? editDraft.value : props.file.content
  return countContentChars(text, props.file.format, { isChapter: props.file.path.startsWith('chapters/') })
})

/** 头部保存状态文案（已保存/未保存/正在保存/保存失败四态，§6） */
const saveStatusLabel = computed(() => {
  if (saveState.value === 'saving') return '正在保存'
  if (saveState.value === 'error') return '保存失败'
  return isDirty.value ? '未保存' : '已保存'
})

// ===== 定位高亮（§7）：反馈条、绿红切分与 Markdown 块映射 =====

const previewRef = ref<HTMLElement | null>(null)

/** 面板当前文件的高亮任务（任意阶段，settled 也保留反馈条）；别的文件的任务不管 */
const panelJob = computed(() => {
  const job = hl.state.job
  return job && props.file && job.path === props.file.path ? job : null
})

/** 颜色还在呈现阶段的任务（settled 只剩重播入口） */
const activeJob = computed(() => (panelJob.value?.phase === 'settled' ? null : panelJob.value))

/** 纯文本预览的高亮切分段（非 Markdown/JSON 且有任务时）；null 走普通整篇渲染 */
const textSegments = computed(() => {
  const job = activeJob.value
  if (!job || !props.file || props.file.format === 'markdown' || props.file.format === 'json') {
    return null
  }
  const range = job.ranges[job.cursor]
  if (!range) return null
  return buildTextHighlightSegments(props.file.content, range, job.oldText)
})

/** Markdown 高亮激活：整块绿显（同版本源码→块映射，不伪造块内精度） */
const mdJobActive = computed(() => Boolean(activeJob.value && props.file && props.file.format === 'markdown'))
const mdCursorRange = computed(() => activeJob.value?.ranges[activeJob.value.cursor] ?? null)
const mdBlocks = computed(() => (mdJobActive.value && props.file ? parseMarkdownBlocks(props.file.content) : []))
const mdStartLines = computed(() => mdBlocks.value.map((block) => block.key))
const mdTotalLines = computed(() => props.file?.content.split('\n').length ?? 0)
/** 绿块：与该处修改的新内容行范围相交的渲染块 */
const mdGreenSet = computed(() => {
  const range = mdCursorRange.value
  if (!range || range.newEnd < range.newStart) return new Set<number>()
  return new Set(markdownBlockIndicesInRange(mdStartLines.value, mdTotalLines.value, range))
})
/** 滚动定位目标块：删除（无绿块）时取插入点所在块 */
const mdTargetIndex = computed(() => {
  const range = mdCursorRange.value
  if (!range) return null
  return markdownBlockIndicesInRange(mdStartLines.value, mdTotalLines.value, range)[0] ?? null
})
/** 红条：被替换/删除的原文（比较用，不写盘） */
const mdRedText = computed(() => {
  const range = mdCursorRange.value
  const job = activeJob.value
  if (!range || !job || range.oldEnd < range.oldStart || job.oldText === '') return null
  return job.oldText
})

/** 任务激活/逐处切换/重播后滚动定位到第一个高亮元素（减少动态效果时即时跳转） */
watch(
  () => {
    const job = hl.state.job
    return job && props.file && job.path === props.file.path
      ? `${job.recordId}:${job.cursor}:${job.phase}`
      : null
  },
  async (key) => {
    if (!key) return
    await nextTick()
    const container = previewRef.value
    if (!container) return
    const targets = [
      ...container.querySelectorAll('.change-hl-green, .change-hl-red, .change-hl-target'),
    ]
    if (targets.length === 0) return
    // 手动计算滚动量，立即跳转：IAB WebView 对 smooth（JS 参数与 CSS）整体忽略且不退化，
    // 定位可靠性优先；减少动态效果下行为一致（§7.5）。
    // 以红段（原文条）+ 绿段（新内容）组成的整块为定位目标：块放得下就整块居中；
    // 章节段落普遍很长（块高于视口是常态），此时把块顶贴近视口顶部，尽量多露出新内容。
    const containerRect = container.getBoundingClientRect()
    const firstRect = targets[0].getBoundingClientRect()
    const lastRect = targets[targets.length - 1].getBoundingClientRect()
    const blockHeight = lastRect.bottom - firstRect.top
    const delta =
      blockHeight <= containerRect.height
        ? firstRect.top - containerRect.top - containerRect.height / 2 + blockHeight / 2
        : firstRect.top - containerRect.top - 80
    container.scrollTo({
      top: Math.max(0, container.scrollTop + delta),
    })
  },
)

watch(
  () => props.file?.path,
  () => {
    // 切换文件：旧文件草稿已随每次编辑实时入表（见 editDraft watch），此处恢复
    // 新文件的草稿；无草稿以磁盘内容初始化——否则 preview 下 isDirty 误报「未保存」。
    // 回预览模式，草稿若存在以「未保存」标记呈现。
    viewMode.value = 'preview'
    editDraft.value = props.file ? (getFileDraft(props.projectId, props.file.path) ?? props.file.content) : ''
    saveState.value = 'idle'
    saveError.value = null
  },
  { immediate: true },
)

// 进入编辑模式时：优先恢复该文件的保留草稿，无草稿才以磁盘当前内容初始化
watch(viewMode, (mode) => {
  if (mode === 'edit') {
    editDraft.value = (props.file ? getFileDraft(props.projectId, props.file.path) : undefined)
      ?? props.file?.content
      ?? ''
  }
})

// 「查看差异」通知点击（§7）：当前文件正在编辑时路径不变，file.path watch 不触发，
// 由令牌 watch 强制切回预览呈现重播差异（草稿保留在草稿表，以「未保存」标记呈现）
watch(
  () => props.locateToken,
  () => {
    if (props.locateToken !== undefined && props.file) {
      viewMode.value = 'preview'
    }
  },
)

// 同文件被外部更新（AI 改动后 ProjectView 重读）：预览模式且无保留草稿时跟随磁盘内容，
// 否则「未保存」标记会对着旧副本误报；编辑模式不动本地草稿副本（§6 草稿保护）
watch(
  () => props.file?.updatedAt,
  () => {
    if (!props.file || viewMode.value === 'edit') {
      return
    }
    if (!getFileDraft(props.projectId, props.file.path)) {
      editDraft.value = props.file.content
    }
  },
)

// 编辑会话中每次改动实时入草稿表（切换文件不静默丢失的关键）；与磁盘一致即清除
watch([editDraft, () => props.file?.path], ([draft, path]) => {
  if (!path || viewMode.value !== 'edit' || !props.file) {
    return
  }
  setFileDraft(props.projectId, path, draft, props.file.content)
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

/**
 * 保存：等待真实写盘结果（§6「保存必须等待真实写盘」）。默认带版本校验
 * （expectedUpdatedAt = 草稿所依据的磁盘版本），版本失配不覆盖外部修改；
 * force 跳过校验（冲突提示里「仍要保存」的覆盖出口）。
 */
async function handleSave(force = false) {
  if (!props.file || !canEdit.value || saveState.value === 'saving' || !isDirty.value) {
    return
  }

  saveState.value = 'saving'
  saveError.value = null
  const outcome = await props.saveFile(props.file.path, editDraft.value, force ? {} : { expectedUpdatedAt: props.file.updatedAt })
  if (outcome.ok) {
    // 保存成功：草稿与磁盘一致，清除保留草稿
    clearFileDraft(props.projectId, props.file.path)
    saveState.value = 'idle'
    return
  }
  saveState.value = 'error'
  saveError.value = { message: outcome.message, conflict: outcome.conflict, diskUpdatedAt: outcome.diskUpdatedAt }
}

/** 冲突出口：放弃草稿、读取磁盘最新（重置本地编辑态） */
function discardDraftAndReload() {
  if (!props.file) return
  clearFileDraft(props.projectId, props.file.path)
  emit('reload', props.file.path)
  viewMode.value = 'preview'
  editDraft.value = ''
  saveState.value = 'idle'
  saveError.value = null
}

/** 非冲突失败出口：放弃本次草稿改动回到磁盘内容 */
function discardDraft() {
  if (props.file) {
    clearFileDraft(props.projectId, props.file.path)
  }
  editDraft.value = props.file?.content ?? ''
  saveState.value = 'idle'
  saveError.value = null
}

defineExpose({
  /** AI 改动重读守卫用：当前文件是否有未保存草稿（草稿不得被静默覆盖，§6） */
  isDirty,
  /** 定位高亮自动播放判定（§7 不抢现场）：面板当前文件/模式/脏态快照 */
  getAutoPlayState: () => ({
    path: props.file?.path ?? null,
    viewMode: viewMode.value,
    dirty: isDirty.value,
  }),
})

/**
 * 预览模式下捕获用户选中的文本，生成引用 chip。
 * 仅预览模式触发（编辑模式选中是编辑操作）。
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
  <div class="flex min-h-0 flex-1 flex-col">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <h2 class="truncate text-sm font-semibold text-gray-800">
          {{ file ? file.name : '内容预览' }}
        </h2>
        <!-- 保存状态四态（§6）：已保存 / 未保存 / 正在保存 / 保存失败 -->
        <span
          v-if="file"
          class="flex shrink-0 items-center gap-1 text-xs"
          :class="{
            'text-gray-400': saveState === 'idle' && !isDirty,
            'text-amber-600': saveState === 'idle' && isDirty,
            'text-blue-600': saveState === 'saving',
            'text-red-600': saveState === 'error',
          }"
        >
          <span
            v-if="saveState === 'idle' && isDirty"
            class="h-1.5 w-1.5 rounded-full bg-amber-500"
          />
          {{ saveStatusLabel }}
        </span>
        <!-- 字数：统计当前阅读版本（编辑模式含未保存草稿） -->
        <span v-if="wordCount !== null" class="shrink-0 text-xs text-gray-500">
          正文 {{ wordCount.toLocaleString('zh-CN') }} 字
        </span>
        <span v-if="file" class="shrink-0 text-xs text-gray-500">
          {{ getLanguageLabel(file.format) }}
        </span>
      </template>
      <template #actions>
        <!-- 预览/编辑 两态分段控件 -->
        <div
          v-if="file"
          class="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5"
        >
          <Tooltip
            v-for="mode in [
              { key: 'preview', label: '预览', icon: 'eye' },
              { key: 'edit', label: '编辑', icon: 'pencil' },
            ]"
            :key="mode.key"
            :text="mode.key === 'edit' && !canEdit ? `${mode.label}（该文件类型不支持编辑）` : mode.label"
            :disabled="mode.key === 'edit' && !canEdit"
            :delay="300"
            preferred-placement="bottom"
          >
            <button
              :aria-label="mode.label"
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
              <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </template>
    </PanelHeader>

    <!-- 内容区域：卡片撑满剩余高度，滚动发生在卡片内部（与计划详情一致） -->
    <div class="flex min-h-0 flex-1 flex-col p-4">
      <!-- 变更通知队列（§7 不抢现场）：用户在编辑/有草稿/看别的文件/后台会话改动时，
           只给可点击通知不强行跳转；点击交 ProjectView 打开文件并重播稳定差异 -->
      <div v-if="hl.state.notices.length > 0" class="mb-3 flex shrink-0 flex-col gap-1.5">
        <div
          v-for="n in hl.state.notices"
          :key="n.recordId"
          class="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-1.5 text-xs"
        >
          <svg class="h-3.5 w-3.5 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span class="min-w-0 flex-1 truncate text-gray-700">
            AI {{ n.status === 'created' ? '新建' : '修改' }}了「{{ n.fileName }}」<span v-if="n.count > 1" class="text-gray-400">（{{ n.count }} 处）</span>
          </span>
          <button
            type="button"
            class="shrink-0 rounded-md border border-blue-200 bg-white px-2 py-0.5 font-medium text-blue-600 transition-colors hover:bg-blue-50"
            @click="emit('locateChange', n)"
          >
            {{ n.canLocate ? '查看差异' : '查看文件' }}
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600"
            aria-label="关闭通知"
            @click="hl.dismissNotice(n.recordId)"
          >
            ×
          </button>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="!file" class="flex flex-1 flex-col items-center justify-center">
        <svg class="mb-4 h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <template v-if="notice">
          <p class="mb-1 text-sm font-medium text-gray-500">「{{ notice.name }}」已被删除</p>
          <p class="max-w-full truncate text-xs text-gray-400" :title="notice.trashPath">
            {{ notice.trashPath ? `原文在回收站：${notice.trashPath}` : '原文已移入项目回收站' }}
          </p>
        </template>
        <template v-else>
          <p class="mb-1 text-sm font-medium text-gray-400">暂无内容</p>
          <p class="text-xs text-gray-400">点击文件或等待 AI 生成</p>
        </template>
      </div>

      <!-- 文件内容 -->
      <div v-else-if="file" class="flex min-h-0 flex-1 flex-col space-y-3">
        <!-- 预览模式 -->
        <div
          v-if="viewMode === 'preview'"
          ref="previewRef"
          class="relative min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4"
          :class="{ 'hl-fading': panelJob?.phase === 'fading' }"
          @mouseup="handleContentMouseup"
        >
          <!-- 定位反馈条（§7）：多处修改逐处切换；淡出后保留「重新查看本轮差异」 -->
          <div
            v-if="panelJob"
            class="sticky top-0 z-10 -mx-4 mb-3 flex items-center gap-2 border-b border-gray-200 bg-gray-50/95 px-4 py-1.5 text-xs text-gray-600 backdrop-blur-sm"
          >
            <template v-if="panelJob.phase !== 'settled'">
              <template v-if="panelJob.ranges.length > 1">
                <button
                  type="button"
                  class="rounded p-0.5 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700"
                  aria-label="上一处修改"
                  @click="hl.advanceCursor(-1)"
                >
                  ‹
                </button>
                <span class="shrink-0">第 {{ panelJob.cursor + 1 }} / {{ panelJob.ranges.length }} 处</span>
                <button
                  type="button"
                  class="rounded p-0.5 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700"
                  aria-label="下一处修改"
                  @click="hl.advanceCursor(1)"
                >
                  ›
                </button>
              </template>
              <span v-else class="shrink-0">AI 刚更新了此文件</span>
              <span class="min-w-0 flex-1" />
            </template>
            <template v-else>
              <span class="shrink-0 text-gray-500">本轮差异已淡出</span>
              <button
                type="button"
                class="ml-auto shrink-0 rounded-md border border-gray-300 bg-white px-2 py-0.5 font-medium text-gray-700 transition-colors hover:bg-gray-100"
                @click="hl.replayJob()"
              >
                重新查看本轮差异
              </button>
            </template>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600"
              aria-label="关闭差异反馈"
              @click="hl.dismissJob()"
            >
              ×
            </button>
          </div>

          <!-- Markdown：高亮激活时整块绿显 + 原码红条（块级映射，不伪造块内精度）；
               无高亮走渲染组件（流式块渲染路径不变） -->
          <template v-if="shouldRenderMarkdown(file.format)">
            <div v-if="mdRedText" class="mb-3">
              <p class="mb-1 text-[10px] text-gray-400">被替换的原文（仅用于比较）</p>
              <pre class="change-hl-static-red whitespace-pre-wrap rounded-md p-2 text-xs text-red-800">{{ mdRedText }}</pre>
            </div>
            <MarkdownRenderer v-if="!mdJobActive" :content="file.content" />
            <div v-else class="markdown-body">
              <div
                v-for="(block, index) in mdBlocks"
                :key="block.key"
                class="markdown-block"
                :class="{
                  'change-hl-green': mdGreenSet.has(index),
                  'change-hl-target': mdGreenSet.size === 0 && mdTargetIndex === index,
                }"
                v-html="block.html"
              />
            </div>
          </template>
          <!-- 纯文本：高亮激活时按当前处切分渲染（绿=新内容行，红=被替换原文） -->
          <pre v-else-if="textSegments" class="whitespace-pre-wrap text-sm text-gray-800"><span
  v-for="(seg, index) in textSegments"
  :key="index"
  :class="seg.kind === 'green' ? 'change-hl-green' : seg.kind === 'red' ? 'change-hl-red' : ''"
>{{ seg.text }}</span></pre>
          <pre v-else class="whitespace-pre-wrap text-sm text-gray-800">{{ file.content }}</pre>
        </div>

        <!-- 编辑模式 -->
        <div v-else-if="viewMode === 'edit'" class="flex min-h-0 flex-1 flex-col rounded-lg border border-gray-200 bg-white p-2">
          <textarea
            v-model="editDraft"
            :disabled="!canEdit"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 p-3 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
            placeholder="该文件类型不支持编辑"
            @keydown="handleKeydown"
          />
          <!-- 保存失败条：失败保留草稿与编辑位置；版本冲突给出覆盖/读取最新出口（§6） -->
          <div
            v-if="saveState === 'error' && saveError"
            class="mt-2 flex shrink-0 flex-col gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2"
            role="alert"
          >
            <p class="text-xs text-red-700">{{ saveError.message }}</p>
            <div class="flex items-center gap-2">
              <template v-if="saveError.conflict">
                <button
                  type="button"
                  class="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500"
                  @click="handleSave(true)"
                >
                  仍要保存（覆盖外部修改）
                </button>
                <button
                  type="button"
                  class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  @click="discardDraftAndReload"
                >
                  读取最新（放弃草稿）
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800"
                  @click="handleSave()"
                >
                  重试
                </button>
                <button
                  type="button"
                  class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  @click="discardDraft"
                >
                  放弃更改
                </button>
              </template>
            </div>
          </div>
          <div class="mt-2 flex shrink-0 items-center justify-between px-1">
            <span class="text-xs text-gray-400">Ctrl/⌘ + S 保存</span>
            <button
              type="button"
              class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
              :disabled="!canEdit || !isDirty || saveState === 'saving'"
              @click="handleSave()"
            >
              {{ saveState === 'saving' ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <!-- 文件信息 -->
        <div class="flex shrink-0 items-center justify-between text-xs text-gray-500">
          <span>{{ file.path }}</span>
          <span v-if="file.updatedAt">{{ new Date(file.updatedAt).toLocaleString('zh-CN') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* 定位高亮（§7）：绿=新内容行/渲染块，红=被替换原文（比较用），target=删除点定位。
   全局样式：MarkdownRenderer 渲染的块节点不带本组件 scoped 属性。
   fading 由预览容器类触发 1.2s 过渡；减少动态效果时禁用过渡。 */
.change-hl-green {
  background-color: rgb(187 247 208 / 0.9);
  border-radius: 2px;
  transition: background-color 1.2s ease;
}

.change-hl-red {
  background-color: rgb(254 202 202 / 0.9);
  border-radius: 2px;
  transition: background-color 1.2s ease;
}

.change-hl-target {
  background-color: rgb(253 230 138 / 0.6);
  border-radius: 2px;
  transition: background-color 1.2s ease;
}

.change-hl-static-red {
  background-color: rgb(254 242 242);
  border: 1px solid rgb(252 165 165 / 0.8);
}

.hl-fading .change-hl-green,
.hl-fading .change-hl-red,
.hl-fading .change-hl-target {
  background-color: transparent;
}

@media (prefers-reduced-motion: reduce) {
  .change-hl-green,
  .change-hl-red,
  .change-hl-target {
    transition: none;
  }
}
</style>
