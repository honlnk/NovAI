<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { FileContentView } from '@novai/core/services/types'
import { countContentChars } from '@novai/core'
import FrontmatterCard from '../ui/FrontmatterCard.vue'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import DetailLayout from './DetailLayout.vue'
import PlainBodySurface from './PlainBodySurface.vue'
import GuardBanner from './GuardBanner.vue'
import ConflictResolutionLayout from './ConflictResolutionLayout.vue'
import ConflictDiffBlocks from './ConflictDiffBlocks.vue'
import type { DetailSavePhase } from './detail-save-phase'
import { useProjectStore } from '../../stores/project'
import {
  acknowledgeRestoredDraft,
  clearFileDraft,
  flushDraftBackupsNow,
  getFileDraft,
  getFileDraftEntry,
  isDraftRestoredFromBackup,
} from '../../composables/useFileDrafts'
import {
  adoptDiskInEditor,
  collapseEditorConflict,
  EDITOR_AUTOSAVE_DEBOUNCE_MS,
  editorSessionPhase,
  expandEditorConflict,
  flushEditorSession,
  flushEditorSessions,
  getEditorSession,
  openEditorSession,
  overwriteEditorContent,
  requestEditorSave,
  setEditorInput,
  rebaseCleanSessionBaseline,
} from '../../composables/editor-session'
import {
  buildTextHighlightSegments,
  markdownBlockIndicesInRange,
  useChangeHighlights,
  type ChangeNotice,
} from '../../composables/useChangeHighlights'
import { buildConflictDiff } from '../../utils/conflict-diff'
import { suggestCopyPath } from '../../utils/file-tree'
import { splitFrontmatter } from '../../utils/frontmatter-display'
import { parseMarkdownBlocks } from '../../utils/markdown-blocks'
import { useTransientEdit } from '../../composables/useTransientEdit'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 普通文件内容（右侧面板的文件内容类型）：预览/编辑两态、引用选中与保存编排。
 * 布局（头部状态灯、模式切换、消息区、正文表面与底部信息行）由统一详情布局
 * DetailLayout 承载（六个模块布局统一计划 阶段 2），本组件保留正文会话、AI 定位、
 * 选文引用和文件专属操作。
 *
 * 保存状态机（正文自动保存与并发冲突交互重设计计划 §四）：
 * 编辑会话按「项目 + 路径」收敛在 editor-session 模块（待写/在途/成功/失败/冲突/
 * 守护统一状态），本组件只负责展示与发送用户操作；保存编排绑定固定归属，
 * 「同路径磁盘版本更新（保存回写）」「切换到另一个文件」「同路径切换到另一个项目」
 * 是三个不同事件——同路径回写不重置编辑态、不清冲突再入口与失败态。
 * 版本冲突一次点击即进入冲突比较：并列查看人工输入与磁盘修改（红=仅草稿有、
 * 绿=仅磁盘有），差异用最新输入与最新磁盘；四个出口中两种采用需二次确认
 * （由 ConflictResolutionLayout 承接两击确认与副本文案）。
 * 草稿守护（§3-3）：AI 删除/重命名有未落盘内容的文件时置入守护会话——
 * 删除给「恢复为草稿副本/放弃草稿并关闭」，重命名给「迁移草稿/放弃草稿并打开新文件」。
 * 刷新后恢复的内容（IndexedDB 恢复镜像回填）以横幅提示，含磁盘基线是否变化。
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
  /** 变更通知「查看差异」请求令牌：ProjectView 每次处理通知点击时递增（路径未变时也要切回预览） */
  locateToken?: number
  /** 草稿恢复令牌：ProjectView 从 IndexedDB 恢复草稿后递增（面板重读当前路径草稿） */
  draftRestoreToken?: number
}>()

const emit = defineEmits<{
  close: []
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

/** 当前路径的编辑会话（状态机数据源；无会话 = 无编辑活动） */
const pathKey = computed(() => props.file?.path ?? '')
const session = computed(() =>
  pathKey.value ? getEditorSession(props.projectId, pathKey.value) ?? null : null,
)
const phase = computed(() => (session.value ? editorSessionPhase(session.value) : 'clean'))
const isSavingThisFile = computed(() => phase.value === 'saving')
const conflictActive = computed(() => session.value?.conflict !== undefined)
const conflictFailure = computed(() =>
  session.value?.failure !== undefined && !conflictActive.value,
)
/** 另存副本表单（冲突界面与删除守护共用；开合与默认名由本组件持有） */
const copyFormOpen = ref(false)
const copyTarget = ref('')
const copyBusy = ref(false)
const copyError = ref('')
/** 副本已保存的提示（原草稿与冲突状态保留） */
const copySavedPath = ref('')

const canEdit = computed(() => {
  return Boolean(props.file && isEditablePath(props.file.path))
})

/** 布局层保存阶段（§四.3 优先顺序）：在途 > 冲突 > 失败 > 待保存 > 已保存 */
const savePhase = computed<DetailSavePhase>(() => {
  if (isSavingThisFile.value) return 'saving'
  if (conflictActive.value) return 'conflict'
  if (conflictFailure.value) return 'failed'
  return isDirty.value ? 'pending' : 'clean'
})

/** 草稿与磁盘内容不一致时为脏，用于显示「等待保存」标记 */
const isDirty = computed(() =>
  session.value !== null && session.value.content !== session.value.baseContent,
)

// 临时编辑（2026-11-23 交互增补）：预览态双击正文进入的编辑标记为「临时」，
// 自动保存完成（pending/saving → clean）即回预览；静置无改动同样亮「等待保存」
// 并在去抖同窗（2 秒）后直接回预览；冲突/失败升级为常规编辑。
// 置于 savePhase/isDirty 之后：watch 初始化求值会立即读 savePhase，提前引用会踩 TDZ
const { markTransient, displaySavePhase } = useTransientEdit({
  savePhase,
  detailMode: viewMode,
  onReturnToPreview: () => setViewMode('preview'),
  idleTimeoutMs: EDITOR_AUTOSAVE_DEBOUNCE_MS,
})

/** 稿件字数（§6）：统计当前阅读版本，编辑模式含未保存草稿；JSON 非稿件不统计。
 * frontmatter 卡片化（2026-11-23）：md 文件开头围栏已是独立卡片，「正文 N 字」排除元数据 */
const wordCount = computed(() => {
  if (!props.file || props.file.format === 'json') {
    return null
  }
  const raw = viewMode.value === 'edit' ? editDraft.value : props.file.content
  const split =
    props.file.format === 'markdown' && viewMode.value === 'preview'
      ? splitFrontmatter(raw)
      : null
  const text = split?.hasFrontmatter ? split.body : raw
  return countContentChars(text, props.file.format, { isChapter: props.file.path.startsWith('chapters/') })
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

/** 删除/重命名守护横幅数据（会话守护状态 + 展示名） */
const guardState = computed(() => {
  const guard = session.value?.guard
  if (!guard) {
    return null
  }
  const path = session.value!.path
  return {
    kind: guard.kind,
    path,
    name: path.split('/').pop() ?? path,
    ...(guard.toPath !== undefined ? { toPath: guard.toPath } : {}),
    ...(guard.trashPath !== undefined ? { trashPath: guard.trashPath } : {}),
  }
})

/** 冲突界面数据（会话冲突展开时的展示形态；差异用最新输入与最新磁盘） */
const conflictView = computed(() => {
  const active = session.value
  const conflict = active?.conflict
  if (!active || !conflict || !conflict.expanded) {
    return null
  }
  return {
    path: active.path,
    /** 人工输入全文（实时最新，不冻结在第一次冲突） */
    draft: active.content,
    draftBase: active.baseContent,
    missing: conflict.missing,
    ...(conflict.unreadable !== undefined ? { unreadable: conflict.unreadable } : {}),
    probing: conflict.probing,
  }
})

/** 冲突界面的差异块（§3-6 版本比较；磁盘可读时；折叠态作用域 = 路径 + 冲突代次） */
const conflictDiff = computed(() => {
  const disk = session.value?.conflict?.disk
  if (!conflictView.value || !disk || conflictView.value.probing) {
    return null
  }
  return buildConflictDiff(conflictView.value.draft, disk.content)
})

/** 冲突界面确认态/折叠态作用域：切换文件或冲突代次推进即复位 */
const conflictScopeKey = computed(() =>
  `${pathKey.value}:${session.value?.conflict?.generation ?? 0}`,
)

// ===== 定位高亮（§7）：反馈条、绿红切分与 Markdown 块映射 =====

/** 预览表面（滚动容器；定位高亮手动计算滚动量） */
const previewSurface = ref<InstanceType<typeof PlainBodySurface> | null>(null)

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
const mdBlocks = computed(() =>
  mdJobActive.value && props.file
    ? parseMarkdownBlocks(props.file.content, { detectFrontmatter: true })
    : [],
)
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
    const container = previewSurface.value?.root ?? null
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

// 「切换文件 / 切换项目」与「同路径磁盘版本更新」是不同事件（§四.4 保存身份）：
// 监听源必须是标量值比较——保存成功会用新文件对象回写同路径，getter 返回新数组的
// 引用比较会把它误判为切换，清掉编辑态、冲突入口与保存错误（2026-11-08 真机缺陷）。
watch(
  [() => props.file?.path, () => props.projectId],
  ([newPath, newProjectId], oldValues) => {
    // 真实切换（旧值存在且不同）：旧现场待写内容立即收口（§阶段 2 离开收口），
    // 收口失败时旧会话保留失败态与镜像，不因切换静默丢失。
    // 切项目收口整个旧项目；切文件收口单个旧路径。
    if (oldValues) {
      const [oldPath, oldProjectId] = oldValues
      if (oldProjectId && oldProjectId !== newProjectId) {
        void flushEditorSessions(oldProjectId)
      } else if (oldPath && oldPath !== newPath) {
        void flushEditorSession(oldProjectId ?? newProjectId, oldPath)
      }
    }
    // 真实切换文件或项目（同路径跨项目也要换会话桶）：恢复新路径的会话草稿；
    // 无草稿以磁盘内容初始化——否则 preview 下 isDirty 误报「未保存」。
    // 回预览模式；冲突/失败态在各自会话里按路径隔离保留，不随切换丢失。
    viewMode.value = 'preview'
    editDraft.value = props.file
      ? (getFileDraft(props.projectId, props.file.path) ?? props.file.content)
      : ''
    copyFormOpen.value = false
    copyError.value = ''
    copySavedPath.value = ''
    // 切换文件时立即落盘草稿备份（数据安全计划 §3-2 的立即落盘时机）
    void flushDraftBackupsNow()
  },
  { immediate: true },
)

// 同路径磁盘版本更新（保存回写 / 外部修改重读）：clean 会话跟随最新磁盘版本
// （最新磁盘版本仍要正确进入保存会话）；有待写内容的会话不动基线——保存时由
// 版本 + 内容哈希校验判定，冲突在阶段 3 冻结。
watch(
  () => [props.file?.path, props.file?.updatedAt, props.projectId] as const,
  ([path]) => {
    if (!props.file || !path || path !== props.file.path) {
      return
    }
    rebaseCleanSessionBaseline(props.projectId, path, props.file.content, props.file.updatedAt)
    if (viewMode.value === 'edit') {
      return
    }
    if (!getFileDraft(props.projectId, path)) {
      editDraft.value = props.file.content
    }
  },
)

// 进入编辑模式时：建立（或恢复）该文件的编辑会话，草稿原样回填；
// 退回预览 = 本文件编辑告一段落：待写内容立即收口（§阶段 2 离开收口），
// 冲突/守护会话不强行写（收口在会话内被拒绝，现场原样保留）
watch(viewMode, (mode, previous) => {
  const file = props.file
  if (mode === 'edit' && file && isEditablePath(file.path)) {
    const active = openEditorSession(props.projectId, file.path, file.content, file.updatedAt)
    editDraft.value = active.content
    return
  }
  if (mode === 'preview' && previous === 'edit' && file) {
    void flushEditorSession(props.projectId, file.path)
  }
})

// 「查看差异」通知点击（§7）：当前文件正在编辑时路径不变，file.path watch 不触发，
// 由令牌 watch 强制切回预览呈现重播差异（草稿保留在会话，以「未保存」标记呈现）
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

// 编辑会话中每次改动实时入会话与恢复镜像（切换文件不静默丢失的关键）；
// 去抖自动保存（阶段 2）由会话模块按 2000ms 窗口自行调度
watch([editDraft, () => props.file?.path, () => props.projectId], ([draft, path, projectId]) => {
  if (!path || viewMode.value !== 'edit' || !props.file) {
    return
  }
  setEditorInput(projectId, path, draft)
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

/** 统一布局模式切换（预览/编辑）：禁用编辑类型已在布局层拦截，这里不再判空 */
function setViewMode(mode: 'preview' | 'edit') {
  viewMode.value = mode
}

/**
 * 编辑模式键盘处理：Ctrl/Cmd+S 立即收口（可选快捷方式，不显示「必须保存」提示）。
 */
function handleKeydown(event: KeyboardEvent) {
  const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key === 's'
  if (isSaveShortcut) {
    event.preventDefault()
    void handleSave()
  }
}

/**
 * 手动保存（§四 统一编排）：会话模块串行调度——快照（内容 + 基线版本 + 基线内容
 * 哈希）在开始时固定，写盘自带版本校验；守护/冲突未解决时内部拒绝写入。
 * 结果只作用于该会话：成功只承认本次快照（在途新输入保留），冲突读取外部版本
 * 并登记（一次点击即进入比较界面）。
 */
async function handleSave() {
  const path = pathKey.value
  if (!path || !canEdit.value) {
    return
  }
  await requestEditorSave(props.projectId, path, { trigger: 'manual' })
}

/** 冲突界面「返回继续编辑」（§3-6）：只离开冲突处理，输入与冲突状态保留（再入口保留） */
function backToEditFromConflict() {
  if (pathKey.value) {
    collapseEditorConflict(props.projectId, pathKey.value)
  }
  copyFormOpen.value = false
  copyError.value = ''
  viewMode.value = 'edit'
}

/** 冲突未处理时的再入口（返回编辑后）：重读磁盘最新，重新展开比较 */
async function reopenSaveConflict() {
  const path = pathKey.value
  if (!path || !conflictActive.value) {
    return
  }
  await expandEditorConflict(props.projectId, path)
}

/**
 * 采纳磁盘版本（§3-6 有损操作，两击确认已由冲突布局完成）：会话层先重新读取磁盘，
 * 读取成功才放弃人工内容并删除恢复记录；读取失败或文件又消失时草稿必须完整保留，
 * 冲突界面呈现最新探测结果（「采用 AI 版本」绝不先删稿后读盘）。
 */
async function adoptDiskVersion() {
  const path = pathKey.value
  if (!path || !conflictView.value) {
    return
  }
  const result = await adoptDiskInEditor(props.projectId, path)
  if (result === 'resolved' && props.file?.path === path) {
    await projectStore.openFile(path)
  }
}

/** 采纳我的草稿（§3-6 有损操作，两击确认已由冲突布局完成）：整份覆盖磁盘；等待期间新输入按新基线保留 */
async function adoptDraftVersion() {
  const path = pathKey.value
  if (!path || !conflictView.value || copyBusy.value) {
    return
  }
  copyBusy.value = true
  const result = await overwriteEditorContent(props.projectId, path)
  copyBusy.value = false
  if (result.ok) {
    return
  }
  copyError.value = result.message ?? '保存失败'
}

/** 打开另存副本表单（冲突界面 / 删除守护共用）；目标名预填不冲突的建议名 */
function openCopyForm(sourcePath: string) {
  copyTarget.value = suggestCopyPath(projectStore.currentProject?.files ?? [], sourcePath)
  copyFormOpen.value = true
  copyError.value = ''
  copySavedPath.value = ''
}

/** 关闭冲突布局内的副本表单（守护表单取消同款语义） */
function closeCopyForm() {
  copyFormOpen.value = false
  copyError.value = ''
}

/**
 * 另存为副本（§3-6）：新建文件语义保存人工内容，不覆盖任何已有文件；
 * 目标存在时提示另选名称。副本保存成功后是否解除来源草稿由调用点决定——
 * 冲突界面的副本保留原草稿与冲突状态；删除守护的副本即草稿去向（清原草稿）。
 */
async function submitCopy(sourcePath: string, options: { resolveSource: boolean }, name: string) {
  const projectId = props.projectId
  const target = name.trim()
  const source = options.resolveSource
    ? (getFileDraft(projectId, sourcePath) ?? session.value?.content ?? conflictView.value?.draft)
    : (conflictView.value?.draft ?? getFileDraft(projectId, sourcePath))
  if (!target || copyBusy.value || source === undefined) {
    return
  }
  copyBusy.value = true
  copyError.value = ''
  const outcome = await projectStore.createFileCopy(target, source, { projectId })
  copyBusy.value = false
  if (!outcome.ok) {
    copyError.value = outcome.message
    return
  }
  copySavedPath.value = target
  copyFormOpen.value = false

  if (options.resolveSource) {
    // 删除守护的「恢复为草稿副本」：草稿内容已成新文件，清原路径草稿并打开副本
    clearFileDraft(projectId, sourcePath)
    emit('guard-resolved')
    if (props.projectId === projectId) {
      await projectStore.refreshTree()
      await projectStore.openFile(target)
    }
  } else if (props.projectId === projectId) {
    // 冲突界面的「将草稿另存为副本」：原草稿与冲突状态保留，由用户继续决定
    await projectStore.refreshTree()
  }
}

/** 删除守护「放弃草稿并关闭」（§3-3）：ProjectView 清草稿并按收尾处理 */
function discardGuardDraft() {
  emit('guard-discard')
}

/** 保存失败条「放弃更改」（§6）：丢掉草稿回到磁盘当前内容，清该会话失败态 */
function discardDraft() {
  const file = props.file
  if (!file) {
    return
  }
  clearFileDraft(props.projectId, file.path)
  editDraft.value = file.content
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
 * 双击选词不算引用：双击已是「进入临时编辑」的入口（临时编辑 2026-11-23）。
 */
function handleContentMouseup(event: MouseEvent) {
  if (!props.file || viewMode.value !== 'preview') return
  if (event.detail > 1) return

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

/**
 * 预览态双击正文 → 临时编辑（快改即走）：自动保存完成后回预览。
 * 高亮回放中不响应（正在呈现 AI 本轮差异，正文是临时回放块）；
 * frontmatter 卡片有自己的点按语义（展开/收起），双击卡片不进入正文编辑；
 * 不可编辑类型（rhythm/foreshadowing/plans 等，由卡片详情负责编辑）不响应。
 */
function handlePreviewDblClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-testid="frontmatter-card"]')) return
  if (!canEdit.value || activeJob.value) return
  markTransient()
  setViewMode('edit')
}
</script>

<template>
  <DetailLayout
    :mode="viewMode"
    :has-content="file !== null"
    :save-phase="displaySavePhase"
    :path="file?.path ?? null"
    :updated-at="file?.updatedAt ?? null"
    :can-edit="canEdit"
    edit-disabled-reason="编辑（该文件类型不支持编辑）"
    :conflict-expanded="conflictView !== null"
    save-testid="file-save-status"
    @close="emit('close')"
    @mode-change="setViewMode"
  >
    <template #title>
      <h2 class="truncate text-sm font-semibold text-gray-800">
        {{ file ? file.name : '内容预览' }}
      </h2>
    </template>

    <!-- 头部元信息：字数（统计当前阅读版本，编辑模式含未保存草稿）与格式 -->
    <template #meta>
      <span v-if="wordCount !== null" class="shrink-0 text-xs text-gray-500">
        正文 {{ wordCount.toLocaleString('zh-CN') }} 字
      </span>
      <span v-if="file" class="shrink-0 text-xs text-gray-500">
        {{ getLanguageLabel(file.format) }}
      </span>
    </template>

    <!-- 消息区：守护横幅 / 恢复提示 / 变更通知 / 冲突紧凑条 / 保存失败 -->
    <template #message>
      <!-- 草稿守护横幅（§3-3）：AI 删除/重命名有人工内容的文件时置入，不自动清空编辑现场 -->
      <GuardBanner
        v-if="guardState"
        :kind="guardState.kind"
        :title="guardState.kind === 'deleted'
          ? `「${guardState.name}」已被 AI 删除并移入回收站`
          : `「${guardState.name}」已被 AI 重命名为 ${guardState.toPath}`"
        :description="guardState.kind === 'deleted'
          ? '你尚未写入正文的内容已保留，不会被自动丢弃；可恢复为一份新文件，或放弃。'
          : '你尚未写入正文的内容仍指向旧路径；迁移后以「等待保存」标记出现在新文件上。'"
        :detail="guardState.kind === 'deleted'
          ? guardState.trashPath ? { label: '原文在回收站', value: guardState.trashPath } : null
          : null"
      >
        <template #actions>
          <template v-if="guardState.kind === 'deleted'">
            <button
              v-if="!copyFormOpen"
              type="button"
              class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500"
              @click="openCopyForm(guardState.path)"
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
        </template>
        <template #form>
          <!-- 删除守护的副本命名表单：新建文件语义，目标存在则要求另选名称 -->
          <div v-if="copyFormOpen && guardState.kind === 'deleted'" class="flex flex-col gap-1.5">
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
                @click="submitCopy(guardState.path, { resolveSource: true }, copyTarget)"
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
        </template>
      </GuardBanner>

      <!-- 刷新后恢复横幅（§3-2）：明确显示「已恢复未保存草稿」及磁盘基线是否变化 -->
      <div
        v-if="restoredNotice && !conflictView"
        class="mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs"
        role="status"
      >
        <AppIcon name="info" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <p class="min-w-0 flex-1 text-blue-800">
          已恢复上次未写完的内容（刷新前的编辑内容）。
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

      <!-- 冲突紧凑状态条（§五.2 非阻塞——AI 先落盘冻结/用户收起比较后的再入口） -->
      <div
        v-if="conflictActive && !conflictView"
        class="mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2"
        role="alert"
      >
        <AppIcon name="triangle-alert" :size="14" class="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <p class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
          此文件有两个版本：磁盘正文已被 AI 修改，你尚未写入正文的内容已保留并暂停自动保存。
        </p>
        <button
          type="button"
          class="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
          @click="reopenSaveConflict"
        >
          比较两个版本
        </button>
      </div>

      <!-- 保存失败条（§6）：原因 + 重试 + 放弃更改（消息区承载，主内容重新分配剩余高度） -->
      <div
        v-if="conflictFailure && session?.failure"
        class="mb-3 flex shrink-0 flex-col gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2"
        role="alert"
      >
        <p class="text-xs text-red-700">{{ session.failure.message }}</p>
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
    </template>

    <!-- 主内容：预览 / 编辑（统一正文表面） -->
    <template #content>
      <!-- 空状态 -->
      <div v-if="!file" class="flex flex-1 flex-col items-center justify-center">
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

      <template v-else>
        <!-- 预览模式：统一正文表面（内部滚动；定位高亮反馈条 + 选文引用） -->
        <PlainBodySurface
          v-if="viewMode === 'preview'"
          ref="previewSurface"
          variant="preview"
          class="relative"
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

          <!-- 正文区（双击进入临时编辑；上方的定位反馈条不属于正文，双击不响应） -->
          <div data-testid="file-preview-body" @dblclick="handlePreviewDblClick">
            <!-- Markdown：高亮激活时整块绿显 + 原码红条（块级映射，不伪造块内精度）；
                 无高亮走渲染组件（流式块渲染路径不变） -->
            <template v-if="shouldRenderMarkdown(file.format)">
              <div v-if="mdRedText" class="mb-3">
                <p class="mb-1 text-[10px] text-gray-400">被替换的原文（仅用于比较）</p>
                <pre class="change-hl-static-red whitespace-pre-wrap rounded-md p-2 text-xs text-red-800">{{ mdRedText }}</pre>
              </div>
              <MarkdownRenderer
                v-if="!mdJobActive"
                :content="file.content"
                :path="file.path"
                frontmatter
              />
              <div v-else class="markdown-body">
                <template v-for="(block, index) in mdBlocks" :key="block.key">
                  <!-- frontmatter 特殊块：卡片渲染；绿显类挂包装层（卡片透明底，整块绿显） -->
                  <div
                    v-if="block.kind === 'frontmatter'"
                    class="markdown-block"
                    :class="{
                      'change-hl-green': mdGreenSet.has(index),
                      'change-hl-target': mdGreenSet.size === 0 && mdTargetIndex === index,
                    }"
                  >
                    <FrontmatterCard :raw="block.raw ?? ''" :path="file.path" />
                  </div>
                  <div
                    v-else
                    class="markdown-block"
                    :class="{
                      'change-hl-green': mdGreenSet.has(index),
                      'change-hl-target': mdGreenSet.size === 0 && mdTargetIndex === index,
                    }"
                    v-html="block.html"
                  />
                </template>
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
        </PlainBodySurface>

        <!-- 编辑模式：统一正文表面（外框不滚动，textarea 自身滚动） -->
        <PlainBodySurface v-else variant="edit">
          <textarea
            v-model="editDraft"
            :disabled="!canEdit"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 p-3 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
            placeholder="该文件类型不支持编辑"
            @keydown="handleKeydown"
          />
        </PlainBodySurface>
      </template>
    </template>

    <!-- 冲突展开：统一冲突处理布局（§五.2 整页版本比较与四出口） -->
    <template #conflict>
      <ConflictResolutionLayout
        :scope-key="conflictScopeKey"
        :probing="conflictView?.probing ?? false"
        :missing="conflictView?.missing ?? false"
        :unreadable="conflictView?.unreadable ?? null"
        :copy-open="copyFormOpen"
        :default-copy-name="copyTarget"
        :copy-busy="copyBusy"
        :copy-error="copyError"
        :copy-saved-note="copySavedPath ? `副本已保存：${copySavedPath}（原草稿与冲突状态保留，仍需决定原文件采用哪个版本）` : ''"
        copy-placeholder="副本文件路径"
        copy-open-label="将草稿另存为副本"
        copy-submit-label="保存副本"
        copy-busy-label="保存中…"
        copy-hint="副本是新建文件，不覆盖任何已有文件；副本保存后本冲突仍保留。"
        copy-input-class="font-mono"
        adopt-disk-label="采用 AI 版本"
        adopt-disk-confirm-label="确认放弃草稿，采用 AI 版本"
        adopt-mine-label="采用我的草稿"
        adopt-mine-confirm-label="确认覆盖磁盘，采用我的草稿"
        @back="backToEditFromConflict"
        @open-copy="openCopyForm(conflictView!.path)"
        @close-copy="closeCopyForm"
        @submit-copy="(name) => submitCopy(conflictView!.path, { resolveSource: false }, name)"
        @adopt-disk="adoptDiskVersion"
        @adopt-mine="adoptDraftVersion"
      >
        <template #header>
          <p class="text-sm font-semibold text-gray-800">此文件有两个版本：磁盘正文已被 AI 修改</p>
          <p class="mt-1 font-mono text-[11px] text-gray-500">{{ conflictView?.path }}</p>
          <p class="mt-1.5 text-xs leading-5 text-gray-600">
            浏览器中的草稿与磁盘上的 AI 修改都完整保留，查看期间互不覆盖。下面按段落对比两个版本：
            <span class="text-red-600">红色段落 = 仅你的草稿有</span>（采纳 AI 版本会丢失），
            <span class="text-green-700">绿色段落 = 仅磁盘有</span>（AI 的修改，采纳草稿会替换）；
            段落内加深的字 = 实际变化的部分，未改动段落默认折叠。
          </p>
        </template>

        <template #probing>正在检查另一版本…</template>
        <template #missing>
          目标文件在磁盘上已不存在（可能已被删除）。你的草稿仍完整保留，可另存为副本后放弃本文件。
        </template>
        <template #unreadable>
          磁盘读取失败：{{ conflictView?.unreadable }}。草稿仍完整保留，可返回编辑或另存副本；读取成功前不能采用磁盘版本。
        </template>

        <template #compare>
          <template v-if="conflictDiff">
            <!-- 差异概览：正常按段计数；降级明示「不做逐段对齐」，不伪装精确 diff -->
            <p v-if="conflictDiff.degraded" class="pb-2 text-xs text-amber-700">
              两个版本差异过大，无法逐段对齐；以下整块对比（红 = 仅你的草稿，绿 = 仅磁盘）。
              <template v-if="conflictDiff.truncated.left > 0">草稿其余 {{ conflictDiff.truncated.left }} 行未显示。</template>
              <template v-if="conflictDiff.truncated.right > 0">磁盘其余 {{ conflictDiff.truncated.right }} 行未显示。</template>
            </p>
            <p v-else-if="conflictDiff.stats.changed + conflictDiff.stats.added + conflictDiff.stats.removed === 0" class="pb-2 text-xs text-gray-500">
              两个版本的文字内容一致（可能只有结尾换行等格式差异）。
            </p>
            <p v-else class="pb-2 text-xs text-gray-500">
              差异概览：修改 {{ conflictDiff.stats.changed }} 段、新增 {{ conflictDiff.stats.added }} 段、删除 {{ conflictDiff.stats.removed }} 段。
            </p>
            <ConflictDiffBlocks :diff="conflictDiff" :fold-scope="conflictScopeKey" />
          </template>
        </template>
      </ConflictResolutionLayout>
    </template>
  </DetailLayout>
</template>

<script lang="ts">
export default { name: 'FilePanelBody' }
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
