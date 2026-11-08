<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { FileContentView, ProjectFileNodeView } from '@novai/core/services/types'
import { countContentChars } from '@novai/core'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import Tooltip from '../ui/Tooltip.vue'
import PanelHeader from './PanelHeader.vue'
import type { SaveFileOutcome } from '../../stores/project'
import { useProjectStore } from '../../stores/project'
import {
  acknowledgeRestoredDraft,
  clearFileDraft,
  flushDraftBackupsNow,
  getFileDraft,
  getFileDraftEntry,
  isDraftRestoredFromBackup,
  setFileDraft,
} from '../../composables/useFileDrafts'
import {
  buildTextHighlightSegments,
  markdownBlockIndicesInRange,
  useChangeHighlights,
  type ChangeNotice,
} from '../../composables/useChangeHighlights'
import { buildLineDiffRows, countLineDiff } from '../../utils/text-diff'
import { suggestCopyPath } from '../../utils/file-tree'
import { applyDraftAfterSave, resolveDraftAfterSave } from '../../utils/save-outcome'
import { parseMarkdownBlocks } from '../../utils/markdown-blocks'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 普通文件内容（右侧面板的文件内容类型）：预览/编辑两态、引用选中与草稿行为。
 * 内容卡片撑满面板剩余高度，滚动发生在卡片内部。
 *
 * 保存状态机（交互优化计划 §6 + 数据安全计划 §3-1/§3-3/§3-6）：
 * - 保存绑定完整请求上下文（项目、路径、内容快照、磁盘版本）：等待写盘期间
 *   切换文件/项目，结果只作用于本次保存的目标；保存期间继续输入的内容保留为
 *   未保存（成功后基线换到刚落盘的内容），不会被成功回调清除；
 * - 保存状态按路径隔离（saving/失败/冲突），不污染当前显示的其他文件；
 * - 版本冲突（AI 已写盘）一次点击即进入冲突界面：并列查看人工草稿与磁盘
 *   修改（红=仅草稿有、绿=仅磁盘有），提供返回编辑/另存副本/两种需二次确认
 *   的有损采用；查看与另存副本均保留原草稿与冲突状态。
 * - 草稿守护（数据安全计划 §3-3）：AI 删除/重命名有人工草稿的文件时，
 *   ProjectView 置入 draftGuard——删除给「恢复为草稿副本/放弃草稿并关闭」，
 *   重命名给「迁移草稿/放弃草稿并打开新文件」，不自动清空编辑现场。
 * - 刷新后恢复的草稿（IndexedDB 备份回填）以横幅提示，含磁盘基线是否变化。
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
  /** 草稿守护（数据安全计划 §3-3）：AI 删除/重命名有人工草稿的当前文件时置入 */
  draftGuard?: DraftGuardState | null
  /** 草稿恢复令牌：ProjectView 从 IndexedDB 恢复草稿后递增（面板重读当前路径草稿） */
  draftRestoreToken?: number
}>()

const emit = defineEmits<{
  close: []
  /** 冲突时「读取最新（放弃草稿）」：ProjectView 重读磁盘内容 */
  reload: [path: string]
  selectQuote: [payload: { path: string; name: string; text: string }]
  /** 点击变更通知：ProjectView 打开对应文件并（可定位时）重播稳定差异 */
  locateChange: [notice: ChangeNotice]
  /** 草稿守护「放弃草稿」：ProjectView 清草稿并按守护类型收尾（清面板/开新文件） */
  'guard-discard': []
  /** 草稿守护（重命名）「把草稿迁移到新文件」：ProjectView 迁移草稿并打开新路径 */
  'guard-migrate': []
  /** 草稿守护已在面板内解决（副本已建/已放弃）：ProjectView 清空守护状态 */
  'guard-resolved': []
}>()

const projectStore = useProjectStore()
const hl = useChangeHighlights(props.projectId)

const viewMode = ref<'preview' | 'edit'>('preview')
const editDraft = ref('')

/** 按路径隔离的保存过程态与失败态（数据安全计划 §3-1：不污染其他文件） */
const savingPaths = reactive(new Set<string>())
type SaveErrorInfo = { message: string; conflict: boolean; diskUpdatedAt?: string }
const saveErrors = reactive(new Map<string, SaveErrorInfo>())

/** 冲突界面状态（§3-6 版本比较与选择）；null = 不在冲突视图 */
type SaveConflictState = {
  path: string
  /** 人工草稿全文（进入冲突时的快照） */
  draft: string
  /** 草稿所依据的磁盘基线（说明用） */
  draftBase: string
  /** 磁盘当前全文（AI 修改后）；missing 时无意义 */
  disk: string
  diskUpdatedAt?: string
  /** 磁盘读取失败（文件已不存在等），与版本变化分开提示 */
  missing: boolean
}
const conflictView = ref<SaveConflictState | null>(null)
/** 有损采用的二次确认步（null=未开始；第二次点击才执行） */
const confirmAdopt = ref<'disk' | 'draft' | null>(null)
/** 另存副本表单（冲突界面与删除守护共用） */
const copyFormOpen = ref(false)
const copyTarget = ref('')
const copyBusy = ref(false)
const copyError = ref('')
/** 副本已保存的提示（原草稿与冲突状态保留） */
const copySavedPath = ref('')

const canEdit = computed(() => {
  return Boolean(props.file && isEditablePath(props.file.path))
})

/** 草稿与磁盘内容不一致时为脏，用于显示「未保存」标记 */
const isDirty = computed(() => editDraft.value !== (props.file?.content ?? ''))

/** 当前路径的保存状态（§3-1 按路径隔离） */
const pathKey = computed(() => props.file?.path ?? '')
const isSavingThisFile = computed(() => pathKey.value !== '' && savingPaths.has(pathKey.value))
const thisFileError = computed(() => (pathKey.value !== '' ? saveErrors.get(pathKey.value) : undefined))

/** 稿件字数（§6）：统计当前阅读版本，编辑模式含未保存草稿；JSON 非稿件不统计 */
const wordCount = computed(() => {
  if (!props.file || props.file.format === 'json') {
    return null
  }
  const text = viewMode.value === 'edit' ? editDraft.value : props.file.content
  return countContentChars(text, props.file.format, { isChapter: props.file.path.startsWith('chapters/') })
})

/** 头部保存状态文案（已保存/未保存/正在保存/保存失败/保存冲突） */
const saveStatusLabel = computed(() => {
  if (isSavingThisFile.value) return '正在保存'
  if (thisFileError.value) return thisFileError.value.conflict ? '保存冲突' : '保存失败'
  return isDirty.value ? '未保存' : '已保存'
})

/** 刷新后恢复提示：当前文件有「恢复且未知悉」的草稿（数据安全计划 §3-2） */
const restoredNotice = computed(() => {
  const path = pathKey.value
  if (!path || !props.file || !isDraftRestoredFromBackup(props.projectId, path)) {
    return null
  }
  const entry = getFileDraftEntry(props.projectId, path)
  return {
    diskChanged: entry ? entry.baseContent !== props.file.content : false,
  }
})

/** 冲突界面的行级差异（§3-6 并列查看） */
const conflictRows = computed(() => {
  const state = conflictView.value
  if (!state || state.missing) {
    return []
  }
  return buildLineDiffRows(state.draft, state.disk)
})

const conflictStats = computed(() => {
  const state = conflictView.value
  if (!state || state.missing) {
    return null
  }
  return countLineDiff(state.draft, state.disk)
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
const mdCursorRange = computed(() => activeJob.value?.ranges[activeJob.value?.cursor ?? 0] ?? null)
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
    saveErrors.delete(pathKey.value)
    copySavedPath.value = ''
    // 切换文件时立即落盘草稿备份（数据安全计划 §3-2 的立即落盘时机）
    void flushDraftBackupsNow()
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

// 草稿恢复令牌（§3-2）：IndexedDB 恢复完成后重读当前路径草稿（恢复晚于面板初始化时）
watch(
  () => props.draftRestoreToken,
  () => {
    if (!props.file) {
      return
    }
    const draft = getFileDraft(props.projectId, props.file.path)
    if (draft !== undefined) {
      editDraft.value = draft
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
 * 保存（数据安全计划 §3-1/§3-6）：开始时固定项目、路径、内容快照与磁盘版本；
 * 写盘自带版本校验（expectedUpdatedAt = 草稿所依据的磁盘版本），磁盘已被 AI
 * 修改时本次写入取消、一次点击即进入冲突界面。
 * 成功回调只处理本次保存绑定的草稿：保存期间继续输入的内容保留为未保存
 *（基线换到刚落盘的内容），与磁盘一致的部分清除。
 */
async function handleSave(force = false) {
  const file = props.file
  if (!file || !canEdit.value || !isDirty.value) {
    return
  }
  const projectId = props.projectId
  const path = file.path
  if (savingPaths.has(path)) {
    return
  }

  const savedDraft = editDraft.value
  const baseUpdatedAt = file.updatedAt

  savingPaths.add(path)
  saveErrors.delete(path)
  copySavedPath.value = ''
  const outcome = await props.saveFile(path, savedDraft, force ? {} : { expectedUpdatedAt: baseUpdatedAt })
  savingPaths.delete(path)

  // 保存完成后的处理全部使用开始时固定的归属（projectId + path），
  // 与当前面板显示哪个文件无关（§3-1：乙的内容、草稿与状态不被甲的保存修改）
  if (outcome.ok) {
    applyDraftAfterSave(
      projectId,
      path,
      resolveDraftAfterSave(getFileDraft(projectId, path), outcome.file.content),
    )
    return
  }

  saveErrors.set(path, {
    message: outcome.message,
    conflict: outcome.conflict,
    ...(outcome.diskUpdatedAt !== undefined ? { diskUpdatedAt: outcome.diskUpdatedAt } : {}),
  })
  if (outcome.conflict) {
    // 版本冲突（AI 已写盘/文件已不存在）：一次点击即进入冲突界面（§3-6）
    await openSaveConflict(path, savedDraft)
  }
}

/** 进入冲突界面：读取磁盘当前内容（AI 修改后），与草稿快照并列呈现 */
async function openSaveConflict(path: string, draft: string) {
  const entry = getFileDraftEntry(props.projectId, path)
  const disk = await projectStore.peekFile(path)
  conflictView.value = {
    path,
    draft,
    draftBase: entry?.baseContent ?? '',
    disk: disk?.content ?? '',
    ...(disk?.updatedAt !== undefined ? { diskUpdatedAt: disk.updatedAt } : {}),
    missing: disk === null,
  }
  confirmAdopt.value = null
  copyFormOpen.value = false
  copyError.value = ''
}

/** 冲突界面「返回继续编辑」（§3-6）：只离开冲突处理，草稿与冲突状态保留 */
function backToEditFromConflict() {
  conflictView.value = null
  confirmAdopt.value = null
  copyFormOpen.value = false
  copyError.value = ''
  viewMode.value = 'edit'
}

/** 冲突未处理时的再入口（返回编辑后）：重读磁盘最新，重新打开冲突界面 */
async function reopenSaveConflict() {
  const error = thisFileError.value
  const path = pathKey.value
  if (!error?.conflict || !path) {
    return
  }
  const draft = getFileDraft(props.projectId, path)
  if (draft === undefined) {
    return
  }
  await openSaveConflict(path, draft)
}

/** 采纳磁盘版本（§3-6 有损操作，需二次确认）：放弃草稿并删除恢复记录，读取磁盘 */
async function adoptDiskVersion() {
  const state = conflictView.value
  if (!state) {
    return
  }
  if (confirmAdopt.value !== 'disk') {
    confirmAdopt.value = 'disk'
    return
  }
  clearFileDraft(props.projectId, state.path)
  saveErrors.delete(state.path)
  conflictView.value = null
  confirmAdopt.value = null
  await projectStore.openFile(state.path)
}

/** 采纳我的草稿（§3-6 有损操作，需二次确认）：草稿整份覆盖磁盘，AI 修改被替换 */
async function adoptDraftVersion() {
  const state = conflictView.value
  if (!state || copyBusy.value) {
    return
  }
  if (confirmAdopt.value !== 'draft') {
    confirmAdopt.value = 'draft'
    return
  }
  copyBusy.value = true
  const outcome = await props.saveFile(state.path, state.draft, { force: true })
  copyBusy.value = false
  if (outcome.ok) {
    clearFileDraft(props.projectId, state.path)
    saveErrors.delete(state.path)
    conflictView.value = null
    confirmAdopt.value = null
    return
  }
  copyError.value = outcome.message
}

/** 打开另存副本表单（冲突界面 / 删除守护共用）；目标名预填不冲突的建议名 */
function openCopyForm(sourcePath: string) {
  copyTarget.value = suggestCopyPath(projectStore.currentProject?.files ?? [], sourcePath)
  copyFormOpen.value = true
  copyError.value = ''
  copySavedPath.value = ''
}

/**
 * 另存为副本（§3-6）：新建文件语义保存人工内容，不覆盖任何已有文件；
 * 目标存在时提示另选名称。副本保存成功后是否解除来源草稿由调用点决定——
 * 冲突界面的副本保留原草稿与冲突状态；删除守护的副本即草稿去向（清原草稿）。
 */
async function submitCopy(sourcePath: string, options: { resolveSource: boolean }) {
  const target = copyTarget.value.trim()
  const source = options.resolveSource
    ? (getFileDraft(props.projectId, sourcePath) ?? conflictView.value?.draft ?? '')
    : (conflictView.value?.draft ?? getFileDraft(props.projectId, sourcePath) ?? '')
  if (!target || copyBusy.value || !source) {
    return
  }
  copyBusy.value = true
  copyError.value = ''
  const outcome = await projectStore.createFileCopy(target, source)
  copyBusy.value = false
  if (!outcome.ok) {
    copyError.value = outcome.message
    return
  }
  copySavedPath.value = target
  copyFormOpen.value = false

  if (options.resolveSource) {
    // 删除守护的「恢复为草稿副本」：草稿内容已成新文件，清原路径草稿并打开副本
    clearFileDraft(props.projectId, sourcePath)
    conflictView.value = null
    saveErrors.delete(sourcePath)
    emit('guard-resolved')
    await projectStore.refreshTree()
    await projectStore.openFile(target)
  } else {
    // 冲突界面的「将草稿另存为副本」：原草稿与冲突状态保留，由用户继续决定
    await projectStore.refreshTree()
  }
}

/** 删除守护「放弃草稿并关闭」（§3-3）：ProjectView 清草稿并按收尾处理 */
function discardGuardDraft() {
  emit('guard-discard')
}

/** 保存失败条「放弃更改」（§6）：丢掉草稿回到磁盘当前内容，清该路径失败态 */
function discardDraft() {
  const file = props.file
  if (!file) {
    return
  }
  clearFileDraft(props.projectId, file.path)
  editDraft.value = file.content
  saveErrors.delete(file.path)
}

/** 重命名守护「把草稿迁移到新文件」（§3-3）：ProjectView 迁移草稿并打开新路径 */
function migrateGuardDraft() {
  emit('guard-migrate')
}

function dismissRestoredNotice() {
  if (pathKey.value) {
    acknowledgeRestoredDraft(props.projectId, pathKey.value)
  }
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
        <!-- 保存状态（§6 + §3-1 按路径隔离）：已保存 / 未保存 / 正在保存 / 保存失败 / 保存冲突 -->
        <span
          v-if="file"
          class="flex shrink-0 items-center gap-1 text-xs"
          :class="{
            'text-gray-400': !isSavingThisFile && !thisFileError && !isDirty,
            'text-amber-600': !isSavingThisFile && !thisFileError && isDirty,
            'text-blue-600': isSavingThisFile,
            'text-red-600': Boolean(thisFileError),
          }"
        >
          <span
            v-if="!isSavingThisFile && !thisFileError && isDirty"
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
              <AppIcon v-if="mode.icon === 'eye'" name="eye" :size="16" class="h-4 w-4" />
              <!-- 编辑（铅笔） -->
              <AppIcon name="square-pen" :size="16" class="h-4 w-4" v-else />
            </button>
          </Tooltip>
        </div>
      </template>
    </PanelHeader>

    <!-- 内容区域：卡片撑满剩余高度，滚动发生在卡片内部（与计划详情一致） -->
    <div class="flex min-h-0 flex-1 flex-col p-4">
      <!-- 草稿守护横幅（§3-3）：AI 删除/重命名有人工草稿的文件时置入，不自动清空编辑现场 -->
      <div
        v-if="draftGuard"
        class="mb-3 flex shrink-0 flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5"
        role="alert"
      >
        <div class="flex items-start gap-2">
          <AppIcon name="triangle-alert" :size="15" class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
            <template v-if="draftGuard.kind === 'deleted'">
              <p class="font-medium">「{{ draftGuard.name }}」已被 AI 删除并移入回收站</p>
              <p class="text-amber-700">你的未保存草稿已保留，不会被自动丢弃；可恢复为一份新文件，或放弃草稿。</p>
              <p v-if="draftGuard.trashPath" class="truncate text-[11px] text-amber-600" :title="draftGuard.trashPath">
                原文在回收站：{{ draftGuard.trashPath }}
              </p>
            </template>
            <template v-else>
              <p class="font-medium">「{{ draftGuard.name }}」已被 AI 重命名为 {{ draftGuard.toPath }}</p>
              <p class="text-amber-700">你的未保存草稿仍指向旧路径；迁移后以「未保存」标记出现在新文件上。</p>
            </template>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <template v-if="draftGuard.kind === 'deleted'">
            <button
              v-if="!copyFormOpen"
              type="button"
              class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500"
              @click="openCopyForm(draftGuard.path)"
            >
              恢复为草稿副本
            </button>
            <button
              type="button"
              class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
              @click="discardGuardDraft"
            >
              放弃草稿并关闭
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500"
              @click="migrateGuardDraft"
            >
              把草稿迁移到新文件
            </button>
            <button
              type="button"
              class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
              @click="discardGuardDraft"
            >
              放弃草稿并打开新文件
            </button>
          </template>
        </div>
        <!-- 删除守护的副本命名表单：新建文件语义，目标存在则要求另选名称 -->
        <div v-if="copyFormOpen && draftGuard.kind === 'deleted'" class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <input
              v-model="copyTarget"
              type="text"
              class="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-xs text-gray-800 focus:border-amber-500 focus:outline-none"
              placeholder="副本文件路径"
            >
            <button
              type="button"
              class="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
              :disabled="copyBusy || !copyTarget.trim()"
              @click="submitCopy(draftGuard.path, { resolveSource: true })"
            >
              {{ copyBusy ? '保存中…' : '保存副本' }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 text-xs text-amber-700 hover:underline"
              @click="copyFormOpen = false; copyError = ''"
            >
              取消
            </button>
          </div>
          <p v-if="copyError" class="text-[11px] text-red-600">{{ copyError }}</p>
          <p class="text-[11px] text-amber-600">副本是新建文件，不会覆盖回收站或磁盘上的任何文件。</p>
        </div>
      </div>

      <!-- 刷新后恢复横幅（§3-2）：明确显示「已恢复未保存草稿」及磁盘基线是否变化 -->
      <div
        v-if="restoredNotice && !conflictView"
        class="mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs"
        role="status"
      >
        <AppIcon name="info" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <p class="min-w-0 flex-1 text-blue-800">
          已恢复未保存草稿（刷新前的编辑内容）。
          <template v-if="restoredNotice.diskChanged">
            磁盘正文在你编辑之后已有变化，草稿基于较早的磁盘版本——保存时会出现两个版本的对比。
          </template>
          <template v-else>磁盘正文与草稿的编辑基线一致。</template>
          恢复不会自动保存，正文文件未被修改。
        </p>
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-blue-400 transition-colors hover:text-blue-600"
          aria-label="知道了"
          @click="dismissRestoredNotice"
        >
          ×
        </button>
      </div>

      <!-- 变更通知队列（§7 不抢现场）：用户在编辑/有草稿/看别的文件/后台会话改动时，
           只给可点击通知不强行跳转；点击交 ProjectView 打开文件并重播稳定差异 -->
      <div v-if="hl.state.notices.length > 0" class="mb-3 flex shrink-0 flex-col gap-1.5">
        <div
          v-for="n in hl.state.notices"
          :key="n.recordId"
          class="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-1.5 text-xs"
        >
          <AppIcon name="square-pen" :size="14" class="h-3.5 w-3.5 shrink-0 text-blue-500" />
          <span class="min-w-0 flex-1 truncate text-gray-700">
            AI {{ n.status === 'created' ? '新建' : '修改' }}了「{{ n.fileName }}」<span v-if="n.count > 1" class="text-gray-400">（{{ n.count }} 处）</span><span v-if="n.sessionTitle" class="text-gray-400">（来自会话「{{ n.sessionTitle }}」）</span>
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

      <!-- 保存冲突界面（§3-6 版本比较与选择）：并列查看人工草稿与 AI 修改后的磁盘正文 -->
      <div
        v-if="conflictView"
        class="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-red-200 bg-white p-3"
        role="alert"
      >
        <div class="shrink-0">
          <p class="text-sm font-semibold text-gray-800">保存冲突：磁盘上的正文已被 AI 修改</p>
          <p class="mt-1 font-mono text-[11px] text-gray-500">{{ conflictView.path }}</p>
          <p class="mt-1.5 text-xs leading-5 text-gray-600">
            浏览器中的草稿与磁盘上的 AI 修改都完整保留，查看期间互不覆盖。下面并列对比两个版本：
            <span class="text-red-600">红色 = 仅你的草稿有</span>（采纳 AI 版本会丢失），
            <span class="text-green-700">绿色 = 仅磁盘有</span>（AI 的修改，采纳草稿会替换）。
          </p>
        </div>

        <!-- 磁盘读取失败与版本变化分开提示（§3-6） -->
        <div v-if="conflictView.missing" class="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          目标文件在磁盘上已不存在（可能已被删除）。你的草稿仍完整保留，可另存为副本后放弃本文件。
        </div>

        <template v-else>
          <p v-if="conflictStats" class="shrink-0 text-xs text-gray-500">
            差异概览：草稿独有 {{ conflictStats.onlyLeft }} 行，磁盘新增 {{ conflictStats.onlyRight }} 行。
          </p>
          <!-- 两栏并列：左 = 我的草稿，右 = 磁盘（AI 修改后） -->
          <div class="grid min-h-0 flex-1 shrink grid-cols-2 gap-2 overflow-hidden">
            <div class="flex min-h-0 flex-col rounded-md border border-gray-200">
              <p class="shrink-0 border-b border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600">我的草稿（未写盘）</p>
              <div class="min-h-0 flex-1 overflow-y-auto p-2">
                <div
                  v-for="(row, index) in conflictRows"
                  :key="`l${index}`"
                  class="whitespace-pre-wrap text-xs leading-5"
                  :class="row.kind === 'left' ? 'conflict-hl-red' : 'text-gray-400'"
                >{{ row.kind === 'right' ? '' : row.text }}&nbsp;</div>
              </div>
            </div>
            <div class="flex min-h-0 flex-col rounded-md border border-gray-200">
              <p class="shrink-0 border-b border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600">磁盘正文（AI 修改后）</p>
              <div class="min-h-0 flex-1 overflow-y-auto p-2">
                <div
                  v-for="(row, index) in conflictRows"
                  :key="`r${index}`"
                  class="whitespace-pre-wrap text-xs leading-5"
                  :class="row.kind === 'right' ? 'conflict-hl-green' : 'text-gray-400'"
                >{{ row.kind === 'left' ? '' : row.text }}&nbsp;</div>
              </div>
            </div>
          </div>
        </template>

        <p v-if="copyError" class="shrink-0 text-xs text-red-600">{{ copyError }}</p>
        <p v-if="copySavedPath" class="shrink-0 text-xs text-green-700">
          副本已保存：{{ copySavedPath }}（原草稿与冲突状态保留，仍需决定原文件采用哪个版本）
        </p>

        <!-- 另存副本表单：新建文件语义，目标存在要求另选名称 -->
        <div v-if="copyFormOpen" class="flex shrink-0 flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <input
              v-model="copyTarget"
              type="text"
              class="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
              placeholder="副本文件路径"
            >
            <button
              type="button"
              class="shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
              :disabled="copyBusy || !copyTarget.trim()"
              @click="submitCopy(conflictView.path, { resolveSource: false })"
            >
              {{ copyBusy ? '保存中…' : '保存副本' }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:underline"
              @click="copyFormOpen = false; copyError = ''"
            >
              取消
            </button>
          </div>
          <p class="text-[11px] text-gray-400">副本是新建文件，不覆盖任何已有文件；副本保存后本冲突仍保留。</p>
        </div>

        <!-- 四个出口（§3-6）：返回编辑 / 另存副本 / 两种需二次确认的有损采用 -->
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
          <button
            type="button"
            class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="backToEditFromConflict"
          >
            返回继续编辑
          </button>
          <button
            v-if="!copyFormOpen"
            type="button"
            class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="openCopyForm(conflictView.path)"
          >
            将草稿另存为副本
          </button>
          <template v-if="!conflictView.missing">
            <span class="min-w-0 flex-1" />
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              :class="confirmAdopt === 'disk'
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
              @click="adoptDiskVersion"
            >
              {{ confirmAdopt === 'disk' ? '确认放弃草稿，采用 AI 版本' : '采用 AI 版本' }}
            </button>
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40"
              :class="confirmAdopt === 'draft'
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
              :disabled="copyBusy"
              @click="adoptDraftVersion"
            >
              {{ confirmAdopt === 'draft' ? '确认覆盖磁盘，采用我的草稿' : '采用我的草稿' }}
            </button>
          </template>
        </div>
        <p class="shrink-0 text-[11px] leading-4 text-gray-400">
          两种「采用」都是有损选择，需要点两次确认；应用不会替你决定，也不提供自动合并。
        </p>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!file" class="flex flex-1 flex-col items-center justify-center">
        <AppIcon name="file-text" :size="48" class="mb-4 h-12 w-12 text-gray-300" />
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
          <!-- 冲突再入口（§3-6 返回编辑后冲突状态保留）：重开两个版本的对比 -->
          <div
            v-if="thisFileError?.conflict"
            class="mt-2 flex shrink-0 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
            role="alert"
          >
            <p class="min-w-0 flex-1 text-xs text-amber-800">
              上次保存与磁盘修改冲突：草稿已保留，两个版本等待你选择。
            </p>
            <button
              type="button"
              class="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
              @click="reopenSaveConflict"
            >
              查看两个版本
            </button>
          </div>
          <!-- 保存失败条：非冲突失败保留草稿与编辑位置，给出重试/放弃出口（§6） -->
          <div
            v-else-if="thisFileError && !thisFileError.conflict"
            class="mt-2 flex shrink-0 flex-col gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2"
            role="alert"
          >
            <p class="text-xs text-red-700">{{ thisFileError.message }}</p>
            <div class="flex items-center gap-2">
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
            </div>
          </div>
          <div class="mt-2 flex shrink-0 items-center justify-between px-1">
            <span class="text-xs text-gray-400">Ctrl/⌘ + S 保存</span>
            <button
              type="button"
              class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
              :disabled="!canEdit || !isDirty || isSavingThisFile"
              @click="handleSave()"
            >
              {{ isSavingThisFile ? '保存中...' : '保存' }}
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

<script lang="ts">
export default { name: 'FilePanelBody' }

/** AI 删除/重命名有人工草稿的文件时的守护状态（数据安全计划 §3-3） */
export type DraftGuardState = {
  kind: 'deleted' | 'renamed'
  /** 草稿所在路径（旧路径） */
  path: string
  name: string
  /** renamed：新路径 */
  toPath?: string
  /** deleted：回收站去向 */
  trashPath?: string
}
</script>

<style>
/* 定位高亮（§7）：绿=新内容行/渲染块，红=被替换的原文（比较用），target=删除点定位。
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

/* 冲突界面（§3-6）：与确认面板同语系，但语义独立（两侧版本对比） */
.conflict-hl-red {
  background-color: rgb(254 202 202 / 0.7);
  border-radius: 2px;
  color: rgb(153 27 27);
}

.conflict-hl-green {
  background-color: rgb(187 247 208 / 0.7);
  border-radius: 2px;
  color: rgb(21 128 61);
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
