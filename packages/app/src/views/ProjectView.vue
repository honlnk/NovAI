<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import { useIndexStore } from '../stores/index'
import { usePlanStore } from '../stores/plan'
import { useSkillStore } from '../stores/skill'
import { useToast } from '../composables/useToast'
import { useConversationFilter } from '../composables/useConversationFilter'
import {
  flushAllEditorSessions,
  flushEditorSessions,
  getEditorProbeHandler,
  getEditorSaveHandler,
  getGuardedEditorSession,
  setAutosaveInputEnabled,
  setEditorProbeHandler,
  setEditorSaveHandler,
  setupEditorAutosaveLifecycle,
} from '../composables/editor-session'
import { setupDraftBackupLifecycle } from '../composables/draft-backup'
import { setupCardBackupLifecycle } from '../composables/card-backup'
import { flushTimelineBackup, setupTimelineBackupLifecycle } from '../composables/timeline-backup'
import { clearChangeHighlights } from '../composables/useChangeHighlights'
import { useCardChangeFeedback } from '../composables/useCardChangeFeedback'
import { useFileChangeFeedback } from '../composables/useFileChangeFeedback'
import {
  clearFileDraft,
  flushDraftBackupsNow,
  hasDirtyDrafts,
  moveFileDraft,
  restorePersistedDrafts,
} from '../composables/useFileDrafts'
import ActivityBar from '../components/layout/ActivityBar.vue'
import CategoryPanel from '../components/layout/CategoryPanel.vue'
import ChatPanel from '../components/layout/ChatPanel.vue'
import ContentPanel from '../components/layout/ContentPanel.vue'
import FilePanelBody from '../components/layout/FilePanelBody.vue'
import IndexStatusBar from '../components/layout/IndexStatusBar.vue'
import WriteConfirmPanel from '../components/layout/WriteConfirmPanel.vue'
import PlanBoardPanel from '../components/plan/PlanBoardPanel.vue'
import PlanDetailPanel from '../components/plan/PlanDetailPanel.vue'
import PlanCreatePanel from '../components/plan/PlanCreatePanel.vue'
import ForeshadowingBoardPanel from '../components/foreshadowing/ForeshadowingBoardPanel.vue'
import ForeshadowingDetailPanel from '../components/foreshadowing/ForeshadowingDetailPanel.vue'
import ForeshadowingCreatePanel from '../components/foreshadowing/ForeshadowingCreatePanel.vue'
import RhythmBoardPanel from '../components/rhythm/RhythmBoardPanel.vue'
import RhythmDetailPanel from '../components/rhythm/RhythmDetailPanel.vue'
import RhythmCreatePanel from '../components/rhythm/RhythmCreatePanel.vue'
import SettingsModal from '../components/settings/SettingsModal.vue'
import RagIndexModal from '../components/rag/RagIndexModal.vue'
import RelationModal from '../components/relation/RelationModal.vue'
import TimelineModal from '../components/timeline/TimelineModal.vue'
import Toast from '../components/ui/Toast.vue'
import FirstTimeGuide from '../components/ui/FirstTimeGuide.vue'
import type { Category } from '../constants/category'
import {
  loadLegacyContentPanelWidth,
  loadWorkspaceState,
  saveWorkspaceState,
} from '../utils/workspace-state'
import type { ChangedFileView, ForeshadowingStatusView, PlanStatusView, RhythmStatusView } from '@novai/core/services/types'
import { pickDirectoryChildren } from '../utils/file-tree'
import { panelCloseTarget, resolveWorkspacePanel } from '../utils/workspace-panel'
import { useForeshadowingStore } from '../stores/foreshadowing'
import { useRhythmStore } from '../stores/rhythm'
import { useTimelineStore } from '../stores/timeline'
import { foreshadowingChapterNumber, type ForeshadowingColumnMode } from '../constants/foreshadowing'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const chatStore = useChatStore()
const indexStore = useIndexStore()
const planStore = usePlanStore()
const skillStore = useSkillStore()
const foreshadowingStore = useForeshadowingStore()
const rhythmStore = useRhythmStore()
const timelineStore = useTimelineStore()
const toast = useToast()
// 「查看已归档」动作经模块级单例切换对话列表筛选（不跨组件转发 ref）
const { showArchived: showArchivedFilter } = useConversationFilter()

const projectId = computed(() => route.params.id as string)
const activeCategory = ref<Category>('chapter')
const isCategoryOpen = ref(true)
const isMobileCategoryOpen = ref(false)
/** 普通文件面板展开偏好（跨分类保留；恢复规则见 workspace-panel） */
const isContentPanelOpen = ref(false)
/** 计划面板（详情/新建）展开偏好（跨分类保留；进入计划默认收起，点击卡片或新建后展开） */
const isPlanPanelOpen = ref(false)
/** 伏笔面板（详情/新建）展开偏好（跨分类保留；与计划面板同构） */
const isForeshadowingPanelOpen = ref(false)
/** 节奏面板（详情/新建）展开偏好（跨分类保留；与伏笔面板同构） */
const isRhythmPanelOpen = ref(false)
/** 写入确认面板开关（§8）：仅在安全时机自动打开，用户可随时离开（关闭面板不取消请求） */
const isConfirmPanelOpen = ref(false)
const showGuide = ref(false)
const isSettingsOpen = ref(false)
const isRagOpen = ref(false)
/** 关系图谱弹窗（独立入口，与向量索引同款按需挂载） */
const isRelationOpen = ref(false)
/** 时间轴弹窗（事件账本入口，与关系图谱同款按需挂载） */
const isTimelineOpen = ref(false)
/** 内容面板选中的引用，透传给 ChatPanel 显示 chip；切文件时清空 */
const selectionQuote = ref<{ path: string; name: string; text: string } | null>(null)
/** 内容面板空态提示（AI 删除了正打开的文件时置入，指向回收站去向；打开新文件时清空） */
const panelNotice = ref<{ name: string; trashPath?: string } | null>(null)
/** 草稿恢复令牌：IndexedDB 恢复完成后递增，驱动 FilePanelBody 重读当前路径草稿 */
const draftRestoreToken = ref(0)

// 编辑会话的保存/外部版本读取服务（§四 统一保存编排）：会话模块通过注入的服务
// 调用 projectStore，保持与 UI 组件解耦；离开项目视图时（收口结束后）注销
const editorSaveService = (path: string, content: string, options?: Parameters<typeof projectStore.saveFile>[2]) =>
  projectStore.saveFile(path, content, options)
const editorProbeService = (path: string, targetProjectId?: string) =>
  projectStore.probeFile(path, targetProjectId)
setEditorSaveHandler(editorSaveService)
setEditorProbeHandler(editorProbeService)

// 输入自动保存（§阶段 2）：进入项目视图即打开 2000ms 去抖收口；应用级开关，
// 视图卸载后写盘服务随之注销（自动触发无服务时自然不写），不再关闭
setAutosaveInputEnabled(true)

/**
 * 内容面板宽度（R7）：从 localStorage 读取，clamp 到 240~720，无记录时默认 320。
 * 持久化到 localStorage（界面偏好），不进 config（项目数据）。
 */
const CONTENT_PANEL_MIN = 240
const CONTENT_PANEL_MAX = 720
const CONTENT_PANEL_DEFAULT = 320
const CONTENT_PANEL_WIDTH_KEY = 'novai:contentPanelWidth'

function loadContentPanelWidth(): number {
  const raw = Number(localStorage.getItem(CONTENT_PANEL_WIDTH_KEY))
  if (!Number.isFinite(raw)) return CONTENT_PANEL_DEFAULT
  return Math.max(CONTENT_PANEL_MIN, Math.min(CONTENT_PANEL_MAX, raw))
}

const contentPanelWidth = ref(loadContentPanelWidth())

watch(contentPanelWidth, (width) => {
  localStorage.setItem(CONTENT_PANEL_WIDTH_KEY, String(width))
})

// ===== 工作区现场恢复（交互优化计划 §3.4）=====
// 按项目存浏览器 localStorage：分类、会话、文件、侧栏与面板展开状态、面板宽度。
// 项目打开后先恢复现场，再接受新选择；恢复完成前禁止持久化，防止初始化默认值覆盖记录。

/** 恢复完成前持久化守卫：初始化流程对 ref 的赋值不得写回恢复记录 */
let workspaceRestored = false
/** 激活代次：项目重恢复时递增，晚到的异步恢复步骤不得覆盖新现场（跨项目不串） */
let workspaceGeneration = 0

/** 把当前现场写入当前项目的恢复记录（各字段缺失时按「明确无」语义落 null）。 */
function persistWorkspaceState() {
  const project = projectStore.currentProject
  if (!workspaceRestored || !project) {
    return
  }
  saveWorkspaceState(project.id, {
    category: activeCategory.value,
    activeSessionId: chatStore.activeSessionId,
    activeFilePath: projectStore.activeFile ? projectStore.activeFile.path : null,
    categoryOpen: isCategoryOpen.value,
    contentPanelOpen: isContentPanelOpen.value,
    planPanelOpen: isPlanPanelOpen.value,
    foreshadowingPanelOpen: isForeshadowingPanelOpen.value,
    rhythmPanelOpen: isRhythmPanelOpen.value,
    contentPanelWidth: contentPanelWidth.value,
  })
}

/**
 * 项目激活后恢复上次现场：
 * - 有记录：恢复分类/侧栏/面板/宽度，会话走 initSessions 首选恢复（失效自动回退），
 *   文件按记录恢复——null 表示用户明确没有选择文件，不得自动打开首文件。
 * - 无记录（首次）：不写任何默认值进记录，沿用现有默认选择。
 * - 记录对象失效（文件读不到/会话不存在）：回退并轻提示，回退后的现场成为新记录。
 */
async function restoreWorkspaceState() {
  const project = projectStore.currentProject
  if (!project) {
    return
  }
  const generation = ++workspaceGeneration
  const record = loadWorkspaceState(project.id)

  if (record) {
    activeCategory.value = record.category
    isCategoryOpen.value = record.categoryOpen
    isContentPanelOpen.value = record.contentPanelOpen
    isPlanPanelOpen.value = record.planPanelOpen
    isForeshadowingPanelOpen.value = record.foreshadowingPanelOpen
    isRhythmPanelOpen.value = record.rhythmPanelOpen
    // 面板宽度：项目记录优先，回退旧全局 key（历史 installations 只有全局一份）
    const width = record.contentPanelWidth ?? loadLegacyContentPanelWidth()
    if (width !== null) {
      contentPanelWidth.value = Math.max(CONTENT_PANEL_MIN, Math.min(CONTENT_PANEL_MAX, width))
    }
  }

  // 会话恢复：initSessions 内部校验首选会话存在性，失效回退最近一条（或新建）
  const preferredSessionId = record?.activeSessionId ?? null
  await chatStore.initSessions(project.id, preferredSessionId)
  if (generation !== workspaceGeneration) {
    return
  }
  const sessionFallback = preferredSessionId !== null
    && !chatStore.sessions.some((s) => s.sessionId === preferredSessionId)

  // 文件恢复：仅记录存在时接管；undefined（旧记录/无记录）沿用 core 的默认首文件行为。
  // 恢复中手动切换（F6 验收2）：用户已手动打开别的文件时不再拉回记录的路径
  let fileFallback = false
  if (record && record.activeFilePath !== undefined) {
    if (projectStore.activeFile) {
      // 用户已选择：尊重当前现场
    } else if (record.activeFilePath === null) {
      projectStore.clearActiveFile()
    } else {
      const opened = await projectStore.openFile(record.activeFilePath)
      if (generation !== workspaceGeneration) {
        return
      }
      if (!opened) {
        projectStore.clearActiveFile()
        fileFallback = true
      }
    }
  }

  // 恢复完成：开启持久化，并把回退后的现场写为新记录（下次不再尝试失效对象）
  workspaceRestored = true
  persistWorkspaceState()
  if (sessionFallback || fileFallback) {
    toast.info('上次的工作区现场部分失效，已回退到最近状态')
  }
}

// 现场任一维度变化即持久化（守卫在 persistWorkspaceState 内）
watch(
  [
    activeCategory,
    isCategoryOpen,
    isContentPanelOpen,
    isPlanPanelOpen,
    isForeshadowingPanelOpen,
    isRhythmPanelOpen,
    contentPanelWidth,
    () => chatStore.activeSessionId,
    () => projectStore.activeFile?.path,
  ],
  persistWorkspaceState,
)

/** 从 currentProject 取配置里的激活大纲路径（分类面板需读取它做高亮联动） */
const activeOutlinePath = computed(() => {
  return projectStore.currentProject?.config.settings.activeOutlinePath ?? null
})

/** 写作大纲列表（prompts/outlines/*.md，拉平），供 ChatPanel 的 @ 指令选择（R4） */
const outlineList = computed(() => {
  const files = projectStore.currentProject?.files ?? []
  return pickDirectoryChildren(files, 'prompts/outlines').filter(
    (n) => n.kind === 'file' && n.path.endsWith('.md'),
  )
})

/** 当前激活大纲的显示名（去 .md 扩展名），ChatPanel 的大纲 chip 展示用（R4） */
const activeOutlineName = computed(() => {
  if (!activeOutlinePath.value) return null
  const node = outlineList.value.find((n) => n.path === activeOutlinePath.value)
  return node ? node.name.replace(/\.md$/i, '') : null
})

onMounted(async () => {
  // 如果没有当前项目，尝试恢复
  if (!projectStore.currentProject) {
    await projectStore.loadLastProjectSummary()
    const restored = await projectStore.openRecentProject(projectId.value)
      || await projectStore.restoreLastOpenedProject()
    if (!restored || restored.id !== projectId.value) {
      router.push('/')
      return
    }
  }

  // 初始化聊天会话并恢复上次工作区现场（恢复内部含会话首选/回退与文件恢复）
  await restoreWorkspaceState()

  // 恢复后停留在伏笔/章节分类时补一次伏笔看板加载：恢复不改分类值则上面的
  // 分类 watch 不触发，章节侧栏「本章相关伏笔」与伏笔面板都没有数据
  if (
    projectStore.currentProject
    && (activeCategory.value === 'foreshadowing' || activeCategory.value === 'chapter')
  ) {
    await foreshadowingStore.loadBoard(projectId.value)
  }

  // 节奏同理：恢复后停留在节奏/章节分类时补一次节奏看板加载（章节侧栏「本章节奏卡」）
  if (
    projectStore.currentProject
    && (activeCategory.value === 'rhythm' || activeCategory.value === 'chapter')
  ) {
    await rhythmStore.loadBoard(projectId.value)
  }

  // 时间线同理：恢复后停留在章节分类时补一次事件账本加载（章节侧栏「本章相关事件」）
  if (projectStore.currentProject && activeCategory.value === 'chapter') {
    void timelineStore.open(projectId.value)
  }

  // 刷新后恢复持久化草稿（§六.2 存量恢复迁移）：逐文件核对磁盘——内容与磁盘
  // 一致清冗余记录；基线一致自动续存（待写内容由自动保存落盘）；磁盘已变建立
  // 版本冲突；原路径已删除进入删除守护。回填本身绝不写正文文件；读取失败明确
  // 提示（保留当前页面内容，不静默置空）。
  try {
    const report = await restorePersistedDrafts(projectId.value)
    const total = report.restored.length + report.conflicted.length + report.guarded.length
    if (total > 0 || report.discarded.length > 0) {
      draftRestoreToken.value += 1
    }
    if (total > 0) {
      const parts = [`已恢复 ${total} 份未写完的内容`]
      if (report.conflicted.length > 0) {
        parts.push(`${report.conflicted.length} 份磁盘已被修改（待版本比较）`)
      }
      if (report.guarded.length > 0) {
        parts.push(`${report.guarded.length} 份原文件已删除（待选择去向）`)
      }
      toast.info(parts.join('；'), { duration: 5000 })
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '读取草稿备份失败')
  }

  // 看板卡片草稿恢复（看板卡片详情自动保存阶段 1）：与正文同一套核对——内容已
  // 与磁盘一致清冗余记录；基线一致回填待续存（阶段 2 打开自动保存后落盘）；磁盘
  // 已变建立冲突；卡片已删进入删除守护。回填不打开详情、不写卡片文件。
  try {
    const reports = await Promise.all([
      planStore.restoreCardDrafts(projectId.value),
      foreshadowingStore.restoreCardDrafts(projectId.value),
      rhythmStore.restoreCardDrafts(projectId.value),
    ])
    const cardTotal = reports.reduce(
      (total, report) => total + report.restored.length + report.conflicted.length + report.guarded.length,
      0,
    )
    if (cardTotal > 0) {
      const conflicted = reports.reduce((total, report) => total + report.conflicted.length, 0)
      const guarded = reports.reduce((total, report) => total + report.guarded.length, 0)
      const parts = [`已恢复 ${cardTotal} 张卡片的未保存编辑`]
      if (conflicted > 0) {
        parts.push(`${conflicted} 张磁盘已被修改（打开详情后比较）`)
      }
      if (guarded > 0) {
        parts.push(`${guarded} 张卡片已删除（待选择去向）`)
      }
      toast.info(parts.join('；'), { duration: 5000 })
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '读取卡片草稿备份失败')
  }

  // 初始化 RAG 索引状态栏（订阅事件 + 首次读取 meta）
  await indexStore.init(projectId.value)

  // 检查是否需要显示首次引导
  if (projectStore.currentProject) {
    const config = projectStore.currentProject.config
    if (!config.llm?.apiKey) {
      showGuide.value = true
    }
  }
})

onUnmounted(() => {
  if (mobileReopenTimer !== null) window.clearTimeout(mobileReopenTimer)
  workspaceGeneration += 1
  indexStore.dispose()
  teardownDraftBackup?.()
  teardownEditorAutosave?.()
  teardownCardBackup?.()
  teardownTimelineBackup?.()
  // 离开项目视图：时间线草稿镜像同步落盘（去抖中的输入不随视图卸载丢失）
  flushTimelineBackup()
  for (const teardown of teardownCardSaveLifecycles) teardown()
  teardownCardSaveLifecycles = []
  // 离开项目视图（阶段 2）：关掉本视图打开的卡片输入自动保存，并尽力收口三域
  // 待写会话（写盘发起即返回，来不及落盘的由恢复镜像兜底）
  planStore.setCardAutosaveEnabled(false)
  foreshadowingStore.setCardAutosaveEnabled(false)
  rhythmStore.setCardAutosaveEnabled(false)
  void planStore.flushAllCards(projectId.value)
  void foreshadowingStore.flushAllCards(projectId.value)
  void rhythmStore.flushAllCards(projectId.value)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  // 离开项目视图（§阶段 2 离开收口）：尽力收口全部待写会话；写盘服务等收口
  // 结束再注销（发起即返回，来不及落盘的内容由恢复镜像兜底）。注销前比对
  // 「还是不是本实例注册的服务」，防快速往返时把新实例的服务一并注销。
  void flushAllEditorSessions()
    .catch(() => {})
    .finally(() => {
      if (getEditorSaveHandler() === editorSaveService) {
        setEditorSaveHandler(null)
      }
      if (getEditorProbeHandler() === editorProbeService) {
        setEditorProbeHandler(null)
      }
    })
})

// 草稿备份生命周期（数据安全计划 §3-2）：页面隐藏/关闭前立即落盘待写备份
// 正文自动保存收口（§阶段 2）在同一时机独立挂接——写盘与镜像互不拖累；
// 看板卡片草稿镜像（阶段 1）、卡片写盘收口（阶段 2）与时间线事件草稿镜像同样挂接
let teardownDraftBackup: (() => void) | null = null
let teardownEditorAutosave: (() => void) | null = null
let teardownCardBackup: (() => void) | null = null
let teardownTimelineBackup: (() => void) | null = null
let teardownCardSaveLifecycles: Array<() => void> = []
onMounted(() => {
  teardownDraftBackup = setupDraftBackupLifecycle()
  teardownEditorAutosave = setupEditorAutosaveLifecycle()
  teardownCardBackup = setupCardBackupLifecycle()
  teardownTimelineBackup = setupTimelineBackupLifecycle()
  teardownCardSaveLifecycles = [
    planStore.setupCardSaveLifecycle(),
    foreshadowingStore.setupCardSaveLifecycle(),
    rhythmStore.setupCardSaveLifecycle(),
  ]
  // 打开三域卡片输入自动保存（阶段 2）：2000ms 去抖由会话引擎承载；测试环境默认
  // 关闭保持手动保存语义，只有生产视图挂载时打开
  planStore.setCardAutosaveEnabled(true)
  foreshadowingStore.setCardAutosaveEnabled(true)
  rhythmStore.setCardAutosaveEnabled(true)
})

// 后台会话保存失败到达（§3-4 保存失败可见 / F11 错误持续）：错误 toast 默认持续显示
// 到用户关闭；进入对应会话现场时数据源记录随之清除（chatStore.selectSession），
// 不再重复提醒。
watch(
  () => chatStore.sessionSaveFailures.size,
  (size, previous) => {
    if (size <= (previous ?? 0)) {
      return
    }
    const latest = [...chatStore.sessionSaveFailures.values()]
      .sort((left, right) => right.at.localeCompare(left.at))[0]
    if (latest) {
      toast.error(`会话保存失败：${latest.message}`)
    }
  },
)

// 未保存内容保护的刷新风险口（§6 + §阶段 2）：有待写/在途/失败/冲突/守护内容时，
// 刷新/关闭标签页给出浏览器原生确认，并立即尝试收口（来不及落盘由恢复镜像兜底）
function handleBeforeUnload(event: BeforeUnloadEvent) {
  const projectId = projectStore.currentProject?.id
  if (projectId && hasDirtyDrafts(projectId)) {
    void flushAllEditorSessions()
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
})

// 监听文件变更，自动刷新分类面板数据。
// 反馈口径（交互优化计划 §5）：后台刷新成功时文件树本身可见更新即反馈，不再
// 无条件报「已更新」（此前刷新失败也会误报成功）；失败时错误原因必须可见——
// projectStore.errorMessage 只在首页渲染，这里就地 toast 报错。
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (newLength > oldLength && projectStore.currentProject) {
      await projectStore.refreshTree()
      if (projectStore.errorMessage) {
        toast.error(`文件列表刷新失败：${projectStore.errorMessage}`)
      }
    }
  },
)

// ===== 文件变更反馈链（交互优化计划 §7 + 正文自动保存计划 §五.2）=====
// file-changed 逐条到达（recentFileChanges 不吞并发改动）：命中当前打开文件且现场
// 无干扰时重读并自动播放差异；编辑/有草稿/看别的文件/后台会话改动 → 只入通知队列。
// AI 先落盘且人工有未落盘内容 → 冻结会话建立冲突；冲突反馈分层（同一冲突只留一个
// 黄色冲突条，不逐次 toast / 蓝色通知）见 useFileChangeFeedback（修复批 2026-11-20
// 从本视图抽出，调用链不变，便于真实事件链测试）。
const { locateToken, handleLocateChange } = useFileChangeFeedback({
  projectId: () => projectId.value,
  getPanelState: () => filePanelRef.value?.getAutoPlayState?.() ?? null,
  openContentPanel: () => {
    isContentPanelOpen.value = true
  },
  setPanelNotice: (notice) => {
    panelNotice.value = notice
  },
})

// ===== 卡片域变更链（阶段 3）=====
// 三个看板目录与正文链并行消费同一账本：有人工未落盘内容的会话在 AI 写盘时
// 冻结并建立冲突（当前卡黄条唯一 / 非当前卡首次一次 toast / 后续静默）；删除/
// 重命名命中 dirty 会话置守护。看板列刷新由下方三个 changedFiles watch 负责。
useCardChangeFeedback({
  projectId: () => projectId.value,
  isCardOpen: (domain, cardId) => {
    const kind = workspacePanel.value?.kind
    if (domain === 'plans') {
      return kind === 'plan-detail' && planStore.selectedCardId === cardId
    }
    if (domain === 'foreshadowing') {
      return kind === 'foreshadowing-detail' && foreshadowingStore.selectedCardId === cardId
    }
    return kind === 'rhythm-detail' && rhythmStore.selectedCardId === cardId
  },
  openContentPanel: () => {
    isContentPanelOpen.value = true
  },
  domains: {
    plans: {
      pathPrefix: 'plans/',
      getCards: () => {
        const board = planStore.board
        return board
          ? Object.values(board.columns).flat().map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.title }))
          : []
      },
      freeze: (pid, cardId) => planStore.freezeForExternalChange(pid, cardId),
      hasDraft: (pid, cardId) => planStore.hasCardDraft(pid, cardId),
      setGuard: (pid, cardId, guard) => planStore.setCardGuard(pid, cardId, guard),
      reopen: (pid, cardId) => planStore.openCard(pid, cardId),
    },
    foreshadowing: {
      pathPrefix: 'foreshadowing/',
      getCards: () => {
        const board = foreshadowingStore.board
        return board
          ? Object.values(board.columns).flat().map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }))
          : []
      },
      freeze: (pid, cardId) => foreshadowingStore.freezeForExternalChange(pid, cardId),
      hasDraft: (pid, cardId) => foreshadowingStore.hasCardDraft(pid, cardId),
      setGuard: (pid, cardId, guard) => foreshadowingStore.setCardGuard(pid, cardId, guard),
      reopen: (pid, cardId) => foreshadowingStore.openCard(pid, cardId),
    },
    rhythm: {
      pathPrefix: 'rhythm/',
      getCards: () => {
        const board = rhythmStore.board
        return board
          ? Object.values(board.columns).flat().map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }))
          : []
      },
      freeze: (pid, cardId) => rhythmStore.freezeForExternalChange(pid, cardId),
      hasDraft: (pid, cardId) => rhythmStore.hasCardDraft(pid, cardId),
      setGuard: (pid, cardId, guard) => rhythmStore.setCardGuard(pid, cardId, guard),
      reopen: (pid, cardId) => rhythmStore.openCard(pid, cardId),
    },
  },
})


// 切项目：清空上一项目的反馈队列与高亮状态（跨项目不串扰；草稿守护随编辑会话
// 按项目隔离，无需清理；消费游标由 useFileChangeFeedback 自清）；切走前把待写
// 草稿备份立即落盘（§3-2 立即落盘时机）
watch(
  projectId,
  (next, previous) => {
    if (previous !== undefined) {
      void flushDraftBackupsNow()
    }
    chatStore.clearRecentFileChanges()
    clearChangeHighlights(projectId.value)
  },
  { immediate: true },
)

// 切换文件时清空选中引用（引用绑定当前文件，避免跨文件残留）；
// 打开了新文件时空态提示随之失效（删除提示只对「已被清空」这一刻有意义）
watch(
  () => projectStore.activeFile?.path,
  (path) => {
    selectionQuote.value = null
    if (path) {
      panelNotice.value = null
    }
  },
)

function handleBackToHome() {
  // 离开项目：待写草稿备份立即落盘（§3-2），内存草稿表保留（回来即恢复）
  void flushDraftBackupsNow()
  projectStore.closeCurrentProject()
  router.push('/')
}

/**
 * 打开设置模态框（R2：从路由页迁移为弹窗，按需挂载，每次打开都重新读取磁盘配置）。
 */
function handleOpenSettings() {
  isSettingsOpen.value = true
}

/**
 * 功能占位项统一反馈。
 * 校对、章节整理、版本管理暂未实现，保留入口但提示「即将推出」。
 */
function handleNotImplemented(name: string) {
  toast.info(`${name}功能即将推出`)
}

// ===== 要素管理员入口（角色机制 W2 提供直聊入口 + 入口重构 W2 删旧弹窗/双击链路） =====

/**
 * 侧栏「管理要素」单击：新建要素管理员直聊会话并切换。
 * 旧参数弹窗与双击直发已删（入口重构 W2），单击不再需要延时防双击。
 */
function handleElementManagerNewSession() {
  void chatStore.createNewSession(projectId.value, { agent: 'element-manager' })
}

// ===== 会话归档（交互优化计划 §3）：不弹确认、不停运行；轻提示带撤销与查看已归档 =====

/** 归档成功后的轻提示动作：撤销（5 秒内）或跳到归档区 */
function handleUndoArchive(sessionId: string, fallbackTo: string | null) {
  void (async () => {
    await chatStore.unarchiveSession(projectId.value, sessionId)
    // 撤销不抢占用户后来切到的会话：仅当激活会话仍是归档时自动切过去的那条才切回
    if (fallbackTo && chatStore.activeSessionId === fallbackTo) {
      await chatStore.selectSession(projectId.value, sessionId)
    }
  })()
}

async function handleArchiveSession(sessionId: string) {
  const archived = chatStore.sessions.find((s) => s.sessionId === sessionId)
  const { fallbackTo } = await chatStore.archiveSession(projectId.value, sessionId)
  toast.success(`已归档「${archived?.title ?? '对话'}」`, {
    duration: 5000,
    actions: [
      { label: '撤销', run: () => handleUndoArchive(sessionId, fallbackTo) },
      { label: '查看已归档', run: () => showArchivedFilter() },
    ],
  })
}

function handleUnarchiveSession(sessionId: string) {
  void (async () => {
    const restored = chatStore.sessions.find((s) => s.sessionId === sessionId)
    await chatStore.unarchiveSession(projectId.value, sessionId)
    toast.info(`已恢复「${restored?.title ?? '对话'}」`)
  })()
}

async function handleSelectFile(path: string) {
  await projectStore.openFile(path)
  isContentPanelOpen.value = true
}

/**
 * 内容面板编辑保存（§四 统一保存编排）：面板把用户操作发给编辑会话模块，
 * 由会话经注入的保存服务（projectStore.saveFile）串行写盘——快照、归属、
 * 冲突与守护状态都在会话内处理，成功/失败/冲突由面板按会话状态呈现。
 */

// ===== 草稿守护动作（数据安全计划 §3-3）：去向由用户明确选择，AI 不代决 =====

/** 「放弃草稿」：删草稿（含持久化备份与守护）并按守护类型收尾（清空面板 / 打开新文件） */
async function handleGuardDiscard() {
  const guarded = getGuardedEditorSession(projectId.value)
  const guard = guarded?.guard
  if (!guarded || !guard) {
    return
  }
  clearFileDraft(projectId.value, guarded.path)
  if (guard.kind === 'deleted') {
    panelNotice.value = {
      name: guarded.path.split('/').pop() ?? '当前文件',
      ...(guard.trashPath !== undefined ? { trashPath: guard.trashPath } : {}),
    }
    projectStore.clearActiveFile()
    return
  }
  if (guard.toPath) {
    await projectStore.openFile(guard.toPath)
  }
}

/** 重命名守护「把草稿迁移到新文件」：迁移草稿（保留旧路径关联，守护随迁移解除）并打开新路径 */
async function handleGuardMigrate() {
  const guarded = getGuardedEditorSession(projectId.value)
  const guard = guarded?.guard
  if (!guarded || guard?.kind !== 'renamed' || !guard.toPath) {
    return
  }
  moveFileDraft(projectId.value, guarded.path, guard.toPath)
  await projectStore.openFile(guard.toPath)
  toast.info('草稿已迁移，以「未保存」标记出现在新文件上')
}

/** 守护已在面板内解决（「恢复为草稿副本」建副本并打开）：清空态提示 */
function handleGuardResolved() {
  panelNotice.value = null
}

/** FilePanelBody 实例引用：AI 改动重读守卫读它的未保存草稿状态 */
const filePanelRef = useTemplateRef('filePanelRef')
const chatPanelRef = useTemplateRef('chatPanelRef')

/** 内容面板选中文字后，把引用存入状态供 ChatPanel 显示 chip */
function handleSelectQuote(payload: { path: string; name: string; text: string }) {
  selectionQuote.value = payload
}

function handleClearQuote() {
  selectionQuote.value = null
}

async function handleChangeOutline(path: string | null) {
  const saved = await projectStore.changeActiveOutlinePath(projectId.value, path)
  if (saved) {
    toast.info(path ? '已切换写作大纲' : '已关闭写作大纲')
  } else {
    toast.error(projectStore.errorMessage || '切换写作大纲失败')
  }
}

// ===== 创作计划板（布局统一计划：看板常驻中央；详情与新建共用右侧内容面板） =====

/** 计划分类侧栏用的卡片摘要（按更新时间倒序取最近） */
const planRecentCards = computed(() => {
  if (!planStore.board) {
    return []
  }
  return [...(Object.values(planStore.board.columns) as import('@novai/core/services/types').PlanCardSummaryView[][])
    .flat()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
})

/** 技能列表标脏（技能包 §3.2 刷新通道）：AI 经文件工具改动 skills/ 后文件树刷新时标记，回到技能分类或点刷新即重算（标脏 O(1)，高频文件变化零成本） */
watch(() => projectStore.currentProject?.files, () => skillStore.markStale())

/** 进入计划分类时加载看板；切回其他分类恢复原对话与文件面板状态（面板偏好都在本组件 ref，天然保留） */
watch(activeCategory, async (category, previous) => {
  // 切换分类 = 离开当前编辑现场（§阶段 2 离开收口）：项目内待写内容立即收口；
  // 冲突/守护会话在收口内部被拒绝，现场按会话保留
  if (previous && projectStore.currentProject) {
    void flushEditorSessions(projectId.value)
    // 三域看板卡片会话同样收口（阶段 2）：两秒去抖内还没写的字段立即落盘
    void planStore.flushAllCards(projectId.value)
    void foreshadowingStore.flushAllCards(projectId.value)
    void rhythmStore.flushAllCards(projectId.value)
  }
  if (category === 'plan' && projectStore.currentProject) {
    await planStore.loadBoard(projectId.value)
  } else if (category === 'skill' && projectStore.currentProject) {
    // 技能分类：同项目幂等（force=false），AI 改动技能经文件树 watch 强制重算
    await skillStore.refresh(projectId.value)
  } else if ((category === 'foreshadowing' || category === 'chapter') && projectStore.currentProject) {
    // 章节分类也要伏笔数据：章节侧栏「本章相关伏笔」实时反查依赖看板摘要
    await foreshadowingStore.loadBoard(projectId.value)
  }
  if ((category === 'rhythm' || category === 'chapter') && projectStore.currentProject) {
    // 章节分类也要节奏数据：章节侧栏「本章节奏卡」实时反查依赖看板摘要
    await rhythmStore.loadBoard(projectId.value)
  }
  if (category === 'chapter' && projectStore.currentProject) {
    // 章节分类也要时间线数据：章节侧栏「本章相关事件」实时反查依赖事件账本视图
    // （open 对同项目幂等；弹窗未挂载时只装载数据不显示）
    void timelineStore.open(projectId.value)
  }
})

/** 切换/关闭项目时清理上一个项目的计划板状态（含编辑会话）与面板展开偏好 */
watch(() => projectStore.currentProject?.id, (_newId, previousId) => {
  // 旧项目的待写内容尽力收口（§阶段 2）：运行时项目已切换，写盘失败时旧会话
  // 保留失败态与恢复镜像，回到该项目时可见可重试，不静默丢失
  if (previousId) {
    void flushEditorSessions(previousId)
  }
  planStore.reset()
  isPlanPanelOpen.value = false
  skillStore.reset()
  foreshadowingStore.reset()
  isForeshadowingPanelOpen.value = false
  rhythmStore.reset()
  isRhythmPanelOpen.value = false
  // 停留在章节分类时补一次时间线加载：章节侧栏「本章相关事件」反查依赖当前项目视图
  if (projectStore.currentProject && activeCategory.value === 'chapter') {
    void timelineStore.open(projectStore.currentProject.id)
  }
})

/** 右侧面板当前应展示的内容与可见性（文件 / 计划详情 / 新建互斥，规则见 workspace-panel） */
const workspacePanel = computed(() => {
  const base = resolveWorkspacePanel({
    category: activeCategory.value,
    isFilePanelOpen: isContentPanelOpen.value,
    hasFileContent: projectStore.activeFile !== null || panelNotice.value !== null,
    isPlanPanelOpen: isPlanPanelOpen.value,
    isCreateOpen: planStore.isCreateOpen,
    hasActiveCard: planStore.activeCard !== null,
    isForeshadowingPanelOpen: isForeshadowingPanelOpen.value,
    isForeshadowingCreateOpen: foreshadowingStore.isCreateOpen,
    hasActiveForeshadowing: foreshadowingStore.activeCard !== null,
    isRhythmPanelOpen: isRhythmPanelOpen.value,
    isRhythmCreateOpen: rhythmStore.isCreateOpen,
    hasActiveRhythm: rhythmStore.activeCard !== null,
  })
  // 写入确认覆盖（§8）：不进 resolveWorkspacePanel（那里不知道确认状态）。基础解析为
  // 文件类或空（面板未开/未开文件）即接管——聊天条「去审阅」必须总能打开；可见的
  // 计划详情/新建优先级更高，不被覆盖
  if (
    isConfirmPanelOpen.value
    && chatStore.activeWriteConfirmation
    && (base.kind === 'file' || base.kind === null)
  ) {
    return { visible: true, kind: 'write-confirm' as const }
  }
  return base
})

/** 面板关闭只影响可见性（§2.8）：按当前内容类型收敛对应分类的展开偏好，不清计划与草稿 */
function handleCloseContentPanel() {
  // 确认面板「离开」：只藏确认面板，不取消请求（§8），也不动文件面板展开偏好
  if (workspacePanel.value.kind === 'write-confirm') {
    isConfirmPanelOpen.value = false
    return
  }
  const target = panelCloseTarget(workspacePanel.value.kind)
  if (target === 'file') {
    isContentPanelOpen.value = false
    // 关闭文件面板（§阶段 2 离开收口）：项目内待写内容立即收口（会话保留，重开即恢复
    // 现场）；备份镜像独立立即落盘（§3-2）
    void flushEditorSessions(projectId.value)
    void flushDraftBackupsNow()
  } else if (target === 'plan') {
    isPlanPanelOpen.value = false
    // 关闭详情面板（阶段 2 离开收口）：待写内容立即落盘，会话保留供重开恢复现场
    void planStore.flushAllCards(projectId.value)
  } else if (target === 'foreshadowing') {
    isForeshadowingPanelOpen.value = false
    void foreshadowingStore.flushAllCards(projectId.value)
  } else if (target === 'rhythm') {
    isRhythmPanelOpen.value = false
    void rhythmStore.flushAllCards(projectId.value)
  }
}

// 确认请求到达/清空（§8）：到达时不抢现场——只在面板空闲（未在看计划）或正以预览态
// 看文件且无未保存草稿时自动切到确认面板；编辑中/有草稿/在看计划时保持聊天条入口。
// 队列清空（最后一项同意/拒绝）后确认面板随之退场（请求已处理，无需再展示）。
watch(
  () => chatStore.pendingConfirmation,
  (head) => {
    if (!head) {
      isConfirmPanelOpen.value = false
      return
    }
    const panel = filePanelRef.value?.getAutoPlayState?.()
    const panelIdle = workspacePanel.value.kind === null
    const filePreviewSafe =
      workspacePanel.value.kind === 'file' &&
      workspacePanel.value.visible &&
      panel?.viewMode === 'preview' &&
      !panel.dirty
    if (chatStore.activeWriteConfirmation && (panelIdle || filePreviewSafe)) {
      isConfirmPanelOpen.value = true
    }
  },
)

/** 打开计划详情（看板卡片 / 侧栏最近计划 / 已搁置卡片共用同一入口）：面板随点击展开 */
async function handleOpenPlanCard(id: string) {
  const openingProjectId = projectId.value
  isPlanPanelOpen.value = true
  await planStore.openCard(openingProjectId, id)
  const error = planStore.detailError
  if (error?.cardId === id && projectId.value === openingProjectId) {
    toast.error(`读取所选计划失败：${error.message}`)
    if (!planStore.activeCard) isPlanPanelOpen.value = false
  }
}

/** 打开新建面板（侧栏摘要卡下方 / 看板空状态共用）：与详情互斥切换，两侧草稿各自保留 */
function handleOpenPlanCreate() {
  isPlanPanelOpen.value = true
  planStore.openCreate()
}

/**
 * 看板顶栏的内容面板收起/展开开关（与其他页面中央头部同一交互）：
 * 展开时若无选中卡片也不在新建，则落到新建表单——保证开关总有可见效果
 * （计划分类默认收起，否则默认态下点展开会没有任何反应）。
 */
function handleTogglePlanPanel() {
  if (workspacePanel.value.visible) {
    handleCloseContentPanel()
    return
  }
  if (planStore.activeCard || planStore.isCreateOpen) {
    isPlanPanelOpen.value = true
    return
  }
  handleOpenPlanCreate()
}

/** AI 或外部写入计划文件后：看板可见时自动刷新（文件变更账本事件驱动） */
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (
      newLength > oldLength
      && activeCategory.value === 'plan'
      && projectStore.currentProject
      && chatStore.changedFiles.some((file) => resolvePlanPathFromChange(file) !== null)
    ) {
      await planStore.refreshBoard(projectId.value)
    }
  },
)

/** 详情打开、不在编辑且不在新建时，外部修改到达：重新读取最新内容（不覆盖用户草稿） */
watch(
  () => chatStore.lastFileChange?.change,
  async (change) => {
    if (
      activeCategory.value !== 'plan'
      || !change
      || !planStore.activeCard
      || planStore.hasUnsavedChanges
      || planStore.isCreateOpen
    ) {
      return
    }
    if (resolvePlanPathFromChange(change) === planStore.activeCard.sourcePath) {
      await planStore.openCard(projectId.value, planStore.activeCard.id)
    }
  },
)

/** change.path / fromPath→toPath 统一取计划路径（renamed 的 toPath 落在 plans/ 才算） */
function resolvePlanPathFromChange(change: ChangedFileView): string | null {
  if (change.type === 'renamed') {
    return change.toPath.startsWith('plans/') ? change.toPath : null
  }
  return change.path.startsWith('plans/') ? change.path : null
}

/** 计划看板重试入口（首载失败横幅 / 后台刷新失败保留旧看板时的重试） */
async function handlePlanRetryLoad() {
  await handlePlanRefresh()
}

/** 左侧计划标题行的刷新入口（布局统一计划 D7）：忙碌态由 isLoading 承载并防重复 */
async function handlePlanRefresh() {
  if (!projectStore.currentProject) {
    return
  }
  await planStore.refreshBoard(projectId.value, { source: 'manual' })
}

/** 刷新技能列表（技能分类标题行入口）；失败轻提示（列表保持旧值） */
async function handleSkillRefresh() {
  if (!projectStore.currentProject) {
    return
  }
  try {
    await skillStore.refresh(projectId.value, true)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '刷新技能失败')
  }
}

/** 让 AI 写技能（§3.5）：预填请求到输入框（不自动发送），光标落在末尾 */
function handleAskAiSkill() {
  chatPanelRef.value?.prefillDraft('请在 skills/ 下帮我新建一个技能：')
}

/** 新建面板提交（看板右上 / 空状态入口共用）：失败保留输入，成功由 store 转入详情预览 */
async function handlePlanSubmitCreate() {
  if (!projectStore.currentProject) {
    return
  }
  const submittingProjectId = projectId.value
  const card = await planStore.submitCreate(submittingProjectId)
  if (projectId.value !== submittingProjectId || projectStore.currentProject?.id !== submittingProjectId) return
  if (card) {
    toast.success('已创建计划')
  } else if (!planStore.isCreateOpen) {
    // 面板已被关闭（异常路径），不再重复报错
    return
  } else {
    toast.error(planStore.actionError || '新建计划失败')
  }
}

async function handlePlanMove(id: string, status: PlanStatusView, afterId: string | null, beforeId?: string | null) {
  if (!projectStore.currentProject) {
    return
  }
  const movingProjectId = projectId.value
  const ok = await planStore.moveCard(movingProjectId, id, status, afterId, beforeId)
  if (projectId.value !== movingProjectId || projectStore.currentProject?.id !== movingProjectId) return
  if (!ok) {
    toast.error(planStore.actionError || '移动计划失败')
  }
}

/** 状态条「重试」（阶段 2 无保存心智）：手动重开当前卡片的失败保存，重开自动补试周期 */
function handlePlanRetrySave() {
  void planStore.retrySave(projectId.value)
}

/**
 * 冲突/守护出口（阶段 3）三域共用的动作组合：紧凑条展开、收起、两击确认后的
 * 有损采用（失败 toast 补可见性——详情 actionError 之外的成功提示也走 toast）。
 */
function makeCardConflictHandlers(store: {
  expandCardConflict: (projectId: string) => void
  collapseCardConflict: () => void
  adoptDiskVersion: (projectId: string) => Promise<boolean>
  overwriteWithMine: (projectId: string) => Promise<{ ok: boolean; message?: string }>
  saveConflictCopy: (projectId: string, name: string) => Promise<unknown>
  restoreConflictCopy: (projectId: string, name: string) => Promise<unknown>
  discardGuardedSession: (projectId: string) => void
}) {
  return {
    expandConflict: () => store.expandCardConflict(projectId.value),
    collapseConflict: () => store.collapseCardConflict(),
    adoptDisk: async () => {
      const ok = await store.adoptDiskVersion(projectId.value)
      if (!ok) {
        toast.error('采用磁盘版本未完成：磁盘读取失败或现场已变化，冲突仍保留')
      }
    },
    adoptMine: async () => {
      const result = await store.overwriteWithMine(projectId.value)
      if (!result.ok) {
        toast.error(result.message ?? '覆盖保存失败，冲突仍保留')
      }
    },
    saveCopy: async (name: string) => {
      const copy = await store.saveConflictCopy(projectId.value, name)
      if (copy) {
        toast.success(`已另存为新卡片：${name}`)
      }
    },
    restoreAsCopy: async (name: string) => {
      // 副本创建与守护清理都在 Store 内绑定发起卡：在途切卡后晚到成功
      // 只清发起卡的守护会话，不误关当前查看的其他卡片
      const copy = await store.restoreConflictCopy(projectId.value, name)
      if (copy) {
        toast.success(`已恢复为新卡片：${name}`)
      }
    },
    discardGuard: () => store.discardGuardedSession(projectId.value),
  }
}

const planConflictHandlers = makeCardConflictHandlers(planStore)

// 自动保存改写计划文件首行（计划名改动触发）后刷新文件树：只在同一张卡前后路径
// 变化时触发，普通内容保存与切卡保存不打扰文件树
watch(
  () => planStore.lastSavedCard,
  (saved, previous) => {
    if (saved && previous?.id === saved.id && previous.sourcePath !== saved.sourcePath) {
      void projectStore.refreshTree()
    }
  },
)

// 非当前卡片的保存失败到达（阶段 2 反馈分层）：详情面板看不见，toast 补一层可见性
watch(
  () => planStore.detailNotice,
  (notice) => {
    if (notice) {
      toast.error(notice.message)
    }
  },
)

// ===== 伏笔账本（创作心智模块阶段二：与计划板同构的看板分类） =====

/** 伏笔分类侧栏用的卡片摘要（按更新时间倒序取最近） */
const foreshadowingRecentCards = computed(() => {
  if (!foreshadowingStore.board) {
    return []
  }
  return [...(Object.values(foreshadowingStore.board.columns) as import('@novai/core/services/types').ForeshadowingCardSummaryView[][])
    .flat()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
})

/** 当前最新章号（该收了高亮的判定基准）：chapters 树里最大章号 */
const latestChapterNumber = computed(() => {
  const files = projectStore.currentProject?.files ?? []
  let latest: number | null = null
  const visit = (nodes: typeof files) => {
    for (const node of nodes) {
      if (node.kind === 'directory') {
        visit(node.children ?? [])
      } else if (node.path.startsWith('chapters/')) {
        const number = foreshadowingChapterNumber(node.name)
        if (number !== null && (latest === null || number > latest)) {
          latest = number
        }
      }
    }
  }
  visit(files)
  return latest
})

/** 伏笔看板列模式（项目设置 foreshadowingStatusMode；看板顶栏按钮切换即保存设置） */
const foreshadowingColumnMode = computed<ForeshadowingColumnMode>(() =>
  projectStore.currentProject?.config.settings.foreshadowingStatusMode === 'full' ? 'full' : 'default')

/** 章节侧栏「本章相关事件」点击：装载数据后打开时间轴并定位该事件详情 */
async function handleOpenTimelineEvent(eventId: string) {
  const pid = projectId.value
  if (!pid) {
    return
  }
  await timelineStore.open(pid)
  await timelineStore.openDetail(eventId)
  isTimelineOpen.value = true
}

/** 打开伏笔详情（看板卡片 / 侧栏最近列表 / 章节侧栏「本章相关伏笔」共用同一入口）：
 *  面板随点击展开；从其他分类（章节侧栏）进入时先切到伏笔分类——详情面板按分类归属展示 */
async function handleOpenForeshadowingCard(id: string) {
  const openingProjectId = projectId.value
  if (activeCategory.value !== 'foreshadowing') {
    selectCategory('foreshadowing')
  }
  isForeshadowingPanelOpen.value = true
  await foreshadowingStore.openCard(openingProjectId, id)
  const error = foreshadowingStore.detailError
  if (error?.cardId === id && projectId.value === openingProjectId) {
    toast.error(`读取所选伏笔失败：${error.message}`)
    if (!foreshadowingStore.activeCard) isForeshadowingPanelOpen.value = false
  }
}

/** 打开新建面板（侧栏摘要卡下方 / 看板空状态共用）：与详情互斥切换，两侧草稿各自保留 */
function handleOpenForeshadowingCreate() {
  isForeshadowingPanelOpen.value = true
  foreshadowingStore.openCreate()
}

/** 看板顶栏的内容面板收起/展开开关：展开时无选中也不在新建则落到新建表单（与计划同约定） */
function handleToggleForeshadowingPanel() {
  if (workspacePanel.value.visible) {
    handleCloseContentPanel()
    return
  }
  if (foreshadowingStore.activeCard || foreshadowingStore.isCreateOpen) {
    isForeshadowingPanelOpen.value = true
    return
  }
  handleOpenForeshadowingCreate()
}

/** AI 或外部写入伏笔文件后：看板可见时自动刷新（文件变更账本事件驱动） */
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (
      newLength > oldLength
      && activeCategory.value === 'foreshadowing'
      && projectStore.currentProject
      && chatStore.changedFiles.some((file) => resolveForeshadowingPathFromChange(file) !== null)
    ) {
      await foreshadowingStore.refreshBoard(projectId.value)
    }
  },
)

/** 详情打开、不在编辑且不在新建时，外部修改到达：重新读取最新内容（不覆盖用户草稿） */
watch(
  () => chatStore.lastFileChange?.change,
  async (change) => {
    if (
      activeCategory.value !== 'foreshadowing'
      || !change
      || !foreshadowingStore.activeCard
      || foreshadowingStore.hasUnsavedChanges
      || foreshadowingStore.isCreateOpen
    ) {
      return
    }
    if (resolveForeshadowingPathFromChange(change) === foreshadowingStore.activeCard.sourcePath) {
      await foreshadowingStore.openCard(projectId.value, foreshadowingStore.activeCard.id)
    }
  },
)

/** change.path / fromPath→toPath 统一取伏笔路径（renamed 的 toPath 落在 foreshadowing/ 才算） */
function resolveForeshadowingPathFromChange(change: ChangedFileView): string | null {
  if (change.type === 'renamed') {
    return change.toPath.startsWith('foreshadowing/') ? change.toPath : null
  }
  return change.path.startsWith('foreshadowing/') ? change.path : null
}

/** 伏笔看板重试入口（首载失败横幅 / 后台刷新失败保留旧看板时的重试） */
async function handleForeshadowingRetryLoad() {
  await handleForeshadowingRefresh()
}

/** 左侧伏笔标题行的刷新入口：忙碌态由 isLoading 承载并防重复 */
async function handleForeshadowingRefresh() {
  if (!projectStore.currentProject) {
    return
  }
  await foreshadowingStore.refreshBoard(projectId.value, { source: 'manual' })
}

/** 新建面板提交：失败保留输入，成功由 store 转入详情预览 */
async function handleForeshadowingSubmitCreate() {
  if (!projectStore.currentProject) {
    return
  }
  const submittingProjectId = projectId.value
  const card = await foreshadowingStore.submitCreate(submittingProjectId)
  if (projectId.value !== submittingProjectId || projectStore.currentProject?.id !== submittingProjectId) return
  if (card) {
    toast.success('已登记伏笔')
  } else if (!foreshadowingStore.isCreateOpen) {
    return
  } else {
    toast.error(foreshadowingStore.actionError || '新建伏笔失败')
  }
}

async function handleForeshadowingMove(id: string, status: ForeshadowingStatusView, afterId: string | null, beforeId?: string | null) {
  if (!projectStore.currentProject) {
    return
  }
  // 拖入「已放弃」列（阶段 4）：不直接写状态也不报缺少原因——打开该卡详情的
  // 原因操作态并暂存本次落点，确认后一次性保存放弃状态、原因与位置；已放弃
  // 卡在列内拖动仍走现有排序（不重复填写原因）
  if (status === 'abandoned') {
    const current = Object.values(foreshadowingStore.board?.columns ?? {})
      .flat()
      .find((card) => card.id === id)
    if (current && current.status !== 'abandoned') {
      const draggingProjectId = projectId.value
      await foreshadowingStore.openCard(draggingProjectId, id)
      if (projectId.value !== draggingProjectId || projectStore.currentProject?.id !== draggingProjectId) return
      // 面板可见性按分类旗标解析（workspacePanel）：这里必须置伏笔面板开关，
      // 不能错用文件面板的 isContentPanelOpen（否则操作态建了面板却不出现）
      isForeshadowingPanelOpen.value = true
      foreshadowingStore.startAbandon(draggingProjectId, { afterId, beforeId: beforeId ?? null })
      return
    }
  }
  const movingProjectId = projectId.value
  const ok = await foreshadowingStore.moveCard(movingProjectId, id, status, afterId, beforeId)
  if (projectId.value !== movingProjectId || projectStore.currentProject?.id !== movingProjectId) return
  if (!ok) {
    toast.error(foreshadowingStore.actionError || '移动伏笔失败')
  }
}

/** 状态条「重试」（阶段 2 无保存心智）：手动重开当前伏笔的失败保存 */
function handleForeshadowingRetrySave() {
  void foreshadowingStore.retrySave(projectId.value)
}

/** 放弃操作态（阶段 4）：详情「已放弃」按钮/拖入已放弃列进入原因登记，确认后原子写入 */
function handleForeshadowingStartAbandon() {
  foreshadowingStore.startAbandon(projectId.value)
}

function handleForeshadowingConfirmAbandon() {
  void foreshadowingStore.confirmAbandonCard(projectId.value)
}

/** 冲突/守护出口（阶段 3，与计划域同构） */
const foreshadowingConflictHandlers = makeCardConflictHandlers(foreshadowingStore)

// 自动保存重命名伏笔文件（伏笔名改动触发）后刷新文件树：同卡前后路径变化才触发
watch(
  () => foreshadowingStore.lastSavedCard,
  (saved, previous) => {
    if (saved && previous?.id === saved.id && previous.sourcePath !== saved.sourcePath) {
      void projectStore.refreshTree()
    }
  },
)

// 非当前卡片的保存失败到达（阶段 2 反馈分层）：详情面板看不见，toast 补一层可见性
watch(
  () => foreshadowingStore.detailNotice,
  (notice) => {
    if (notice) {
      toast.error(notice.message)
    }
  },
)

/** 看板顶栏列模式切换：写回项目设置（novel.config.json），所有伏笔视图随之换口径 */
async function handleToggleForeshadowingColumnMode() {
  if (!projectStore.currentProject) {
    return
  }
  const nextMode: ForeshadowingColumnMode = foreshadowingColumnMode.value === 'full' ? 'default' : 'full'
  const saved = await projectStore.changeForeshadowingStatusMode(projectId.value, nextMode)
  if (!saved) {
    toast.error(projectStore.errorMessage || '切换伏笔列模式失败')
  }
}

// ===== 节奏卡看板（创作心智模块阶段四：三列状态机 + 列内重排） =====

/** 节奏侧栏摘要（按更新时间倒序取最近） */
const rhythmRecentCards = computed(() => {
  if (!rhythmStore.board) {
    return []
  }
  return [...(Object.values(rhythmStore.board.columns) as import('@novai/core/services/types').RhythmCardSummaryView[][])
    .flat()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
})

/** 打开节奏卡详情（看板卡片 / 侧栏最近列表 / 章节侧栏「本章节奏卡」共用同一入口） */
async function handleOpenRhythmCard(id: string) {
  const openingProjectId = projectId.value
  if (activeCategory.value !== 'rhythm') {
    selectCategory('rhythm')
  }
  isRhythmPanelOpen.value = true
  await rhythmStore.openCard(openingProjectId, id)
  const error = rhythmStore.detailError
  if (error?.cardId === id && projectId.value === openingProjectId) {
    toast.error(`读取所选节奏卡失败：${error.message}`)
    if (!rhythmStore.activeCard) isRhythmPanelOpen.value = false
  }
}

/** 打开新建面板（侧栏摘要卡下方 / 看板空状态共用）：与详情互斥切换，草稿保留 */
function handleOpenRhythmCreate() {
  isRhythmPanelOpen.value = true
  rhythmStore.openCreate()
}

/** 看板顶栏的内容面板收起/展开开关：展开时无选中也不在新建则落到新建表单（与计划/伏笔同约定） */
function handleToggleRhythmPanel() {
  if (workspacePanel.value.visible) {
    handleCloseContentPanel()
    return
  }
  if (rhythmStore.activeCard || rhythmStore.isCreateOpen) {
    isRhythmPanelOpen.value = true
    return
  }
  handleOpenRhythmCreate()
}

/** AI 或外部写入节奏文件后：看板可见时自动刷新（文件变更账本事件驱动） */
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (
      newLength > oldLength
      && activeCategory.value === 'rhythm'
      && projectStore.currentProject
      && chatStore.changedFiles.some((file) => resolveRhythmPathFromChange(file) !== null)
    ) {
      await rhythmStore.refreshBoard(projectId.value)
    }
  },
)

/** 详情打开、不在编辑且不在新建时，外部修改到达：重新读取最新内容（不覆盖用户草稿） */
watch(
  () => chatStore.lastFileChange?.change,
  async (change) => {
    if (
      activeCategory.value !== 'rhythm'
      || !change
      || !rhythmStore.activeCard
      || rhythmStore.hasUnsavedChanges
      || rhythmStore.isCreateOpen
    ) {
      return
    }
    if (resolveRhythmPathFromChange(change) === rhythmStore.activeCard.sourcePath) {
      await rhythmStore.openCard(projectId.value, rhythmStore.activeCard.id)
    }
  },
)

/** change.path / fromPath→toPath 统一取节奏卡路径（renamed 的 toPath 落在 rhythm/ 才算） */
function resolveRhythmPathFromChange(change: ChangedFileView): string | null {
  if (change.type === 'renamed') {
    return change.toPath.startsWith('rhythm/') ? change.toPath : null
  }
  return change.path.startsWith('rhythm/') ? change.path : null
}

/** 节奏看板重试/刷新入口 */
async function handleRhythmRefresh() {
  if (!projectStore.currentProject) {
    return
  }
  await rhythmStore.refreshBoard(projectId.value, { source: 'manual' })
}

/** 新建面板提交：失败保留输入，成功由 store 转入详情预览 */
async function handleRhythmSubmitCreate() {
  if (!projectStore.currentProject) {
    return
  }
  const submittingProjectId = projectId.value
  const card = await rhythmStore.submitCreate(submittingProjectId)
  if (projectId.value !== submittingProjectId || projectStore.currentProject?.id !== submittingProjectId) return
  if (card) {
    toast.success('已登记节奏卡')
  } else if (!rhythmStore.isCreateOpen) {
    return
  } else {
    toast.error(rhythmStore.actionError || '新建节奏卡失败')
  }
}

/** 看板列内重排（跨列拖拽在 constants/rhythm.ts 落点放行处已被忽略） */
async function handleRhythmMove(id: string, status: RhythmStatusView, afterId: string | null, beforeId?: string | null) {
  if (!projectStore.currentProject) {
    return
  }
  const movingProjectId = projectId.value
  const ok = await rhythmStore.moveCard(movingProjectId, id, status, afterId, beforeId)
  if (projectId.value !== movingProjectId || projectStore.currentProject?.id !== movingProjectId) return
  if (!ok) {
    toast.error(rhythmStore.actionError || '移动节奏卡失败')
  }
}

/** 状态条「重试」（阶段 2 无保存心智）：手动重开当前节奏卡的失败保存 */
function handleRhythmRetrySave() {
  void rhythmStore.retrySave(projectId.value)
}

/** 冲突/守护出口（阶段 3，与计划域同构） */
const rhythmConflictHandlers = makeCardConflictHandlers(rhythmStore)

// 自动保存重命名节奏卡文件（节奏卡名改动触发）后刷新文件树：同卡前后路径变化才触发
watch(
  () => rhythmStore.lastSavedCard,
  (saved, previous) => {
    if (saved && previous?.id === saved.id && previous.sourcePath !== saved.sourcePath) {
      void projectStore.refreshTree()
    }
  },
)

// 非当前卡片的保存失败到达（阶段 2 反馈分层）：详情面板看不见，toast 补一层可见性
watch(
  () => rhythmStore.detailNotice,
  (notice) => {
    if (notice) {
      toast.error(notice.message)
    }
  },
)

/** 移动端「关旧开新」的重开定时器：展开态点其他分类，抽屉关合间隙换内容 */
let mobileReopenTimer: number | null = null

function selectCategory(category: Category) {
  // 切换分类时确保面板展开
  isCategoryOpen.value = true
  // 桌面端直接切换；不设置 isMobileCategoryOpen，避免缩窗时抽屉意外弹出
  // （64rem 与 Tailwind lg 断点一致）
  if (!window.matchMedia('(width < 64rem)').matches) {
    activeCategory.value = category
    return
  }
  // 移动端：ActivityBar 分类点击即展开抽屉（移动端唯一的抽屉入口，顶栏汉堡已移除）
  if (mobileReopenTimer !== null) {
    window.clearTimeout(mobileReopenTimer)
    mobileReopenTimer = null
  }
  if (!isMobileCategoryOpen.value) {
    // 抽屉收着：直接换内容并展开
    activeCategory.value = category
    isMobileCategoryOpen.value = true
    return
  }
  if (category === activeCategory.value) {
    // 同分类：保持展开不动
    return
  }
  // 已展开且换了分类：抽屉先滑出（关旧），关合间隙换内容，再滑入（开新）。
  // 抽屉过渡 duration-200，220ms 留余量保证完全滑出后再重开
  isMobileCategoryOpen.value = false
  mobileReopenTimer = window.setTimeout(() => {
    mobileReopenTimer = null
    activeCategory.value = category
    isMobileCategoryOpen.value = true
  }, 220)
}

function toggleSidebar() {
  isCategoryOpen.value = !isCategoryOpen.value
}

function toggleContentPanel() {
  // 确认面板打开时，头部开关即「离开确认审阅」（§8 离开不取消请求，聊天条保留入口）
  if (workspacePanel.value.kind === 'write-confirm') {
    isConfirmPanelOpen.value = false
    return
  }
  isContentPanelOpen.value = !isContentPanelOpen.value
}

function handleCloseGuide() {
  showGuide.value = false
}

function handleGoToSettings() {
  showGuide.value = false
  handleOpenSettings()
}
</script>

<template>
  <div class="flex h-screen flex-col bg-white">
    <div class="flex min-h-0 flex-1">
      <!-- 移动端分类面板遮罩：全屏铺满（与右侧内容面板遮罩一致）。工具栏 z-[46]
           高于遮罩 z-40，侧栏始终可见可点——展开态点其他分类触发「关旧开新」，
           不会点到遮罩先关抽屉；Transition 让遮罩随抽屉开合淡入淡出不闪变 -->
      <Transition name="mask-fade">
        <div
          v-if="isMobileCategoryOpen"
          class="fixed inset-0 z-40 bg-black/50 lg:hidden"
          @click="isMobileCategoryOpen = false"
        />
      </Transition>

      <!-- Activity Bar（最左竖条） -->
      <ActivityBar
        :active-category="activeCategory"
        @select="selectCategory"
        @open-settings="handleOpenSettings"
        @back-to-home="handleBackToHome"
        @proofread="handleNotImplemented('校对')"
        @organize="handleNotImplemented('章节整理')"
        @version="handleNotImplemented('版本管理')"
        @elementManager="handleElementManagerNewSession"
        @rag="isRagOpen = true"
        @relation="isRelationOpen = true"
        @timeline="isTimelineOpen = true"
      />

      <!-- 分类面板（随 Activity Bar 切换） -->
      <CategoryPanel
        :active-category="activeCategory"
        :project-id="projectId"
        :files="projectStore.currentProject?.files ?? []"
        :active-file-path="projectStore.activeFile?.path"
        :active-outline-path="activeOutlinePath"
        :sessions="chatStore.sessions"
        :active-session-id="chatStore.activeSessionId"
        :pending-confirmation-ids="chatStore.sessionsWithPendingConfirmations"
        :plan-cards="planRecentCards"
        :is-plan-loading="planStore.isLoading"
        :selected-plan-card-id="planStore.selectedCardId"
        :foreshadowing-cards="foreshadowingRecentCards"
        :is-foreshadowing-loading="foreshadowingStore.isLoading"
        :selected-foreshadowing-id="foreshadowingStore.selectedCardId"
        :rhythm-cards="rhythmRecentCards"
        :is-rhythm-loading="rhythmStore.isLoading"
        :selected-rhythm-id="rhythmStore.selectedCardId"
        :timeline-events="timelineStore.chapterEvents"
        :pending-question-ids="chatStore.sessionsWithPendingQuestions"
        :running-ids="chatStore.runningSessionIds"
        :skills="skillStore.skills"
        :broken-skills="skillStore.broken"
        :is-skill-loading="skillStore.isLoading"
        :is-open="isCategoryOpen"
        :is-mobile-open="isMobileCategoryOpen"
        @select-file="handleSelectFile"
        @change-outline="handleChangeOutline"
        @close-mobile="isMobileCategoryOpen = false"
        @select-session="(sessionId) => chatStore.selectSession(projectId, sessionId)"
        @create-session="chatStore.createNewSession(projectId)"
        @rename-session="(sessionId, title) => chatStore.renameSession(projectId, sessionId, title)"
        @archive-session="handleArchiveSession"
        @unarchive-session="handleUnarchiveSession"
        @delete-session="(sessionId) => chatStore.deleteSession(projectId, sessionId)"
        @open-plan-board="selectCategory('plan')"
        @refresh-plan="handlePlanRefresh"
        @refresh-skills="handleSkillRefresh"
        @ask-ai-skill="handleAskAiSkill"
        @open-plan-create="handleOpenPlanCreate"
        @open-plan-card="(id) => { selectCategory('plan'); handleOpenPlanCard(id) }"
        @open-foreshadowing-board="selectCategory('foreshadowing')"
        @refresh-foreshadowing="handleForeshadowingRefresh"
        @open-foreshadowing-create="handleOpenForeshadowingCreate"
        @open-foreshadowing-card="(id) => { selectCategory('foreshadowing'); handleOpenForeshadowingCard(id) }"
        @open-rhythm-board="selectCategory('rhythm')"
        @refresh-rhythm="handleRhythmRefresh"
        @open-rhythm-create="handleOpenRhythmCreate"
        @open-timeline-event="handleOpenTimelineEvent"
        @open-rhythm-card="(id) => { selectCategory('rhythm'); handleOpenRhythmCard(id) }"
      />

      <!-- 中间主内容区：看板分类（计划/伏笔）显示看板（始终保留），其余分类为对话 -->
      <PlanBoardPanel
        v-if="activeCategory === 'plan'"
        :board="planStore.board"
        :is-loading="planStore.isLoading"
        :error-message="planStore.errorMessage"
        :selected-card-id="planStore.selectedCardId"
        :show-on-hold="planStore.showOnHold"
        :is-sidebar-open="isCategoryOpen"
        :is-content-panel-open="workspacePanel.visible"
        @open-create="handleOpenPlanCreate"
        @open-card="handleOpenPlanCard"
        @move-card="handlePlanMove"
        @retry-load="handlePlanRetryLoad"
        @toggle-on-hold="planStore.showOnHold = !planStore.showOnHold"
        @toggle-sidebar="toggleSidebar"
        @toggle-content-panel="handleTogglePlanPanel"
      />
      <ForeshadowingBoardPanel
        v-else-if="activeCategory === 'foreshadowing'"
        :board="foreshadowingStore.board"
        :is-loading="foreshadowingStore.isLoading"
        :error-message="foreshadowingStore.errorMessage"
        :selected-card-id="foreshadowingStore.selectedCardId"
        :column-mode="foreshadowingColumnMode"
        :latest-chapter-number="latestChapterNumber"
        :is-sidebar-open="isCategoryOpen"
        :is-content-panel-open="workspacePanel.visible"
        @open-create="handleOpenForeshadowingCreate"
        @open-card="handleOpenForeshadowingCard"
        @move-card="handleForeshadowingMove"
        @retry-load="handleForeshadowingRetryLoad"
        @toggle-column-mode="handleToggleForeshadowingColumnMode"
        @toggle-sidebar="toggleSidebar"
        @toggle-content-panel="handleToggleForeshadowingPanel"
      />
      <RhythmBoardPanel
        v-else-if="activeCategory === 'rhythm'"
        :board="rhythmStore.board"
        :is-loading="rhythmStore.isLoading"
        :error-message="rhythmStore.errorMessage"
        :selected-card-id="rhythmStore.selectedCardId"
        :is-sidebar-open="isCategoryOpen"
        :is-content-panel-open="workspacePanel.visible"
        @open-create="handleOpenRhythmCreate"
        @open-card="handleOpenRhythmCard"
        @move-card="handleRhythmMove"
        @retry-load="handleRhythmRefresh"
        @toggle-sidebar="toggleSidebar"
        @toggle-content-panel="handleToggleRhythmPanel"
      />
      <ChatPanel
        v-else
        ref="chatPanelRef"
        :project-id="projectId"
        :is-sidebar-open="isCategoryOpen"
        :is-content-panel-open="workspacePanel.visible"
        :quote="selectionQuote"
        :outlines="outlineList"
        :active-outline-path="activeOutlinePath"
        @toggle-sidebar="toggleSidebar"
        @toggle-content-panel="toggleContentPanel"
        @clear-quote="handleClearQuote"
        @change-outline="handleChangeOutline"
        @open-confirm-review="isConfirmPanelOpen = true"
      >
        <!-- 首次使用引导 -->
        <template #guide>
          <FirstTimeGuide
            v-if="showGuide"
            @close="handleCloseGuide"
            @go-to-settings="handleGoToSettings"
          />
        </template>
      </ChatPanel>

      <!-- 右侧内容面板：普通文件 / 计划详情 / 新建计划 同一外壳（宽度、收起、遮罩统一承载） -->
      <ContentPanel
        :is-open="workspacePanel.visible"
        :width="contentPanelWidth"
        @close="handleCloseContentPanel"
        @resize="contentPanelWidth = $event"
        @reset-width="contentPanelWidth = CONTENT_PANEL_DEFAULT"
      >
        <!-- 普通文件：v-show 保挂载——编辑会话与草稿状态跨分类切换不得丢失（D12 §2.6-4）；
             kind 互斥由 workspacePanel 规则保证，计划两侧各自 v-if -->
        <FilePanelBody
          v-show="workspacePanel.kind === 'file'"
          ref="filePanelRef"
          :file="projectStore.activeFile"
          :project-id="projectId"
          :notice="panelNotice"
          :locate-token="locateToken"
          :draft-restore-token="draftRestoreToken"
          @close="handleCloseContentPanel"
          @select-quote="handleSelectQuote"
          @locate-change="handleLocateChange"
          @guard-discard="handleGuardDiscard"
          @guard-migrate="handleGuardMigrate"
          @guard-resolved="handleGuardResolved"
        />
        <!-- 写入确认面板（§8）：接管内容面板时 FilePanelBody 由 v-show 隐藏（保持挂载、草稿不丢） -->
        <WriteConfirmPanel
          v-if="workspacePanel.kind === 'write-confirm' && chatStore.activeWriteConfirmation"
          :confirmation="chatStore.activeWriteConfirmation"
          :total-count="chatStore.pendingConfirmationCount"
          @confirm="chatStore.confirmWriteTool()"
          @reject="chatStore.rejectWriteTool()"
          @close="handleCloseContentPanel"
        />
        <!-- 计划详情 -->
        <PlanDetailPanel
          v-if="workspacePanel.kind === 'plan-detail' && planStore.activeCard"
          :active-card="planStore.activeCard"
          :draft-body="planStore.draftBody"
          :draft-title="planStore.draftTitle"
          :draft-status="planStore.draftStatus"
          :detail-mode="planStore.detailMode"
          :save-phase="planStore.savePhase"
          :conflict="planStore.conflictView"
          :conflict-fields="planStore.conflictFields"
          :guard="planStore.guardNotice"
          :conflict-copy-busy="planStore.conflictCopyBusy"
          :conflict-copy-error="planStore.conflictCopyError"
          :action-error="planStore.actionError"
          @close="handleCloseContentPanel"
          @update-draft="planStore.updateDraft"
          @update-draft-title="planStore.updateDraftTitle"
          @update-draft-status="planStore.updateDraftStatus"
          @set-detail-mode="planStore.setDetailMode"
          @retry-save="handlePlanRetrySave"
          @expand-conflict="planConflictHandlers.expandConflict"
          @collapse-conflict="planConflictHandlers.collapseConflict"
          @adopt-disk="planConflictHandlers.adoptDisk"
          @adopt-mine="planConflictHandlers.adoptMine"
          @save-copy="planConflictHandlers.saveCopy"
          @restore-as-copy="planConflictHandlers.restoreAsCopy"
          @discard-guard="planConflictHandlers.discardGuard"
        />
        <!-- 新建计划 -->
        <PlanCreatePanel
          v-if="workspacePanel.kind === 'plan-create'"
          :new-card-title="planStore.newCardTitle"
          :new-card-body="planStore.newCardBody"
          :is-creating="planStore.isCreating"
          :action-error="planStore.actionError"
          @close="handleCloseContentPanel"
          @update-create-draft="(title, body) => planStore.updateCreateDraft(title, body)"
          @submit-create="handlePlanSubmitCreate"
          @cancel="planStore.closeCreate(false)"
        />
        <!-- 伏笔详情 -->
        <ForeshadowingDetailPanel
          v-if="workspacePanel.kind === 'foreshadowing-detail' && foreshadowingStore.activeCard"
          :active-card="foreshadowingStore.activeCard"
          :draft-name="foreshadowingStore.draftName"
          :draft-reader-view="foreshadowingStore.draftReaderView"
          :draft-author-truth="foreshadowingStore.draftAuthorTruth"
          :draft-status="foreshadowingStore.draftStatus"
          :detail-mode="foreshadowingStore.detailMode"
          :save-phase="foreshadowingStore.savePhase"
          :conflict="foreshadowingStore.conflictView"
          :conflict-fields="foreshadowingStore.conflictFields"
          :guard="foreshadowingStore.guardNotice"
          :conflict-copy-busy="foreshadowingStore.conflictCopyBusy"
          :conflict-copy-error="foreshadowingStore.conflictCopyError"
          :abandon-intent="foreshadowingStore.abandonIntent"
          :can-confirm-abandon="foreshadowingStore.canConfirmAbandon"
          :is-confirming-abandon="foreshadowingStore.isConfirmingAbandon"
          :action-error="foreshadowingStore.actionError"
          @close="handleCloseContentPanel"
          @update-draft-name="foreshadowingStore.updateDraftName"
          @update-draft-reader-view="foreshadowingStore.updateDraftReaderView"
          @update-draft-author-truth="foreshadowingStore.updateDraftAuthorTruth"
          @update-draft-status="foreshadowingStore.updateDraftStatus"
          @start-abandon="handleForeshadowingStartAbandon"
          @update-abandon-reason="(reason: string) => foreshadowingStore.updateAbandonReason(projectId, reason)"
          @cancel-abandon="() => foreshadowingStore.cancelAbandon(projectId)"
          @confirm-abandon="handleForeshadowingConfirmAbandon"
          @set-detail-mode="foreshadowingStore.setDetailMode"
          @retry-save="handleForeshadowingRetrySave"
          @expand-conflict="foreshadowingConflictHandlers.expandConflict"
          @collapse-conflict="foreshadowingConflictHandlers.collapseConflict"
          @adopt-disk="foreshadowingConflictHandlers.adoptDisk"
          @adopt-mine="foreshadowingConflictHandlers.adoptMine"
          @save-copy="foreshadowingConflictHandlers.saveCopy"
          @restore-as-copy="foreshadowingConflictHandlers.restoreAsCopy"
          @discard-guard="foreshadowingConflictHandlers.discardGuard"
          />
        <!-- 登记伏笔 -->
        <ForeshadowingCreatePanel
          v-if="workspacePanel.kind === 'foreshadowing-create'"
          :new-name="foreshadowingStore.newCardName"
          :new-reader-view="foreshadowingStore.newCardReaderView"
          :new-author-truth="foreshadowingStore.newCardAuthorTruth"
          :new-planted-at="foreshadowingStore.newCardPlantedAt"
          :new-payoff-start="foreshadowingStore.newCardPayoffStart"
          :new-payoff-end="foreshadowingStore.newCardPayoffEnd"
          :can-submit="foreshadowingStore.hasRequiredCreateInput"
          :is-creating="foreshadowingStore.isCreating"
          :action-error="foreshadowingStore.actionError"
          @close="handleCloseContentPanel"
          @update-create-draft="foreshadowingStore.updateCreateDraft"
          @submit-create="handleForeshadowingSubmitCreate"
          @cancel="foreshadowingStore.closeCreate(false)"
        />
        <!-- 节奏卡详情 -->
        <RhythmDetailPanel
          v-if="workspacePanel.kind === 'rhythm-detail' && rhythmStore.activeCard"
          :active-card="rhythmStore.activeCard"
          :draft-name="rhythmStore.draftName"
          :draft-planned-conflict="rhythmStore.draftPlannedConflict"
          :draft-planned-mood="rhythmStore.draftPlannedMood"
          :draft-planned-hook="rhythmStore.draftPlannedHook"
          :draft-planned-payoff="rhythmStore.draftPlannedPayoff"
          :draft-planned-characters="rhythmStore.draftPlannedCharacters"
          :draft-planned-note="rhythmStore.draftPlannedNote"
          :draft-intent-body="rhythmStore.draftIntentBody"
          :detail-mode="rhythmStore.detailMode"
          :save-phase="rhythmStore.savePhase"
          :conflict="rhythmStore.conflictView"
          :conflict-fields="rhythmStore.conflictFields"
          :guard="rhythmStore.guardNotice"
          :conflict-copy-busy="rhythmStore.conflictCopyBusy"
          :conflict-copy-error="rhythmStore.conflictCopyError"
          :action-error="rhythmStore.actionError"
          @close="handleCloseContentPanel"
          @update-draft="rhythmStore.updateDraft"
          @set-detail-mode="rhythmStore.setDetailMode"
          @retry-save="handleRhythmRetrySave"
          @expand-conflict="rhythmConflictHandlers.expandConflict"
          @collapse-conflict="rhythmConflictHandlers.collapseConflict"
          @adopt-disk="rhythmConflictHandlers.adoptDisk"
          @adopt-mine="rhythmConflictHandlers.adoptMine"
          @save-copy="rhythmConflictHandlers.saveCopy"
          @restore-as-copy="rhythmConflictHandlers.restoreAsCopy"
          @discard-guard="rhythmConflictHandlers.discardGuard"
          />
        <!-- 规划节奏卡 -->
        <RhythmCreatePanel
          v-if="workspacePanel.kind === 'rhythm-create'"
          :new-name="rhythmStore.newCardName"
          :new-chapter-ref="rhythmStore.newCardChapterRef"
          :new-planned-conflict="rhythmStore.newCardPlannedConflict"
          :new-planned-mood="rhythmStore.newCardPlannedMood"
          :new-planned-hook="rhythmStore.newCardPlannedHook"
          :new-planned-payoff="rhythmStore.newCardPlannedPayoff"
          :new-planned-characters="rhythmStore.newCardPlannedCharacters"
          :new-intent-body="rhythmStore.newCardIntentBody"
          :can-submit="rhythmStore.hasRequiredCreateInput"
          :is-creating="rhythmStore.isCreating"
          :action-error="rhythmStore.actionError"
          @close="handleCloseContentPanel"
          @update-create-draft="rhythmStore.updateCreateDraft"
          @submit-create="handleRhythmSubmitCreate"
          @cancel="rhythmStore.closeCreate(false)"
        />
      </ContentPanel>
    </div>

    <!-- 底部项目状态栏：索引状态 + 当前大纲 + 本轮执行状态（常驻，随项目激活） -->
    <IndexStatusBar
      :project-id="projectId"
      :active-outline-name="activeOutlineName"
      :run-status="chatStore.runStatus"
      :run-status-type="chatStore.runStatusType"
      @clear-outline="handleChangeOutline(null)"
    />

    <!-- 设置模态框（按需挂载：关闭时销毁，再次打开重新读取磁盘配置） -->
    <SettingsModal
      v-if="isSettingsOpen"
      :project-id="projectId"
      @close="isSettingsOpen = false"
    />

    <!-- 向量索引管理模态框（独立入口，不进设置弹窗；状态与底部状态栏共享 indexStore） -->
    <RagIndexModal
      v-if="isRagOpen"
      :project-id="projectId"
      @close="isRagOpen = false"
    />

    <!-- 关系图谱弹窗（独立入口；画布/详情/保存会话状态在 relationStore） -->
    <RelationModal
      v-if="isRelationOpen"
      :project-id="projectId"
      @close="isRelationOpen = false"
    />

    <!-- 时间轴弹窗（事件账本入口；阶段 1 空壳，阶段 3 接入时间轴渲染与详情编辑） -->
    <TimelineModal
      v-if="isTimelineOpen"
      :project-id="projectId"
      @close="isTimelineOpen = false"
    />

    <!-- Toast 提示：容器统一定位，多条并存纵向堆叠不遮挡（交互优化计划 §3） -->
    <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      <div v-for="t in toast.toasts.value" :key="t.id" class="pointer-events-auto">
        <Toast
          :message="t.message"
          :type="t.type"
          :duration="t.persistent ? null : t.duration"
          :actions="t.actions"
          @close="toast.remove(t.id)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩淡入淡出：与抽屉滑入滑出（duration-200）同步，开关瞬间不再生硬闪现 */
.mask-fade-enter-active,
.mask-fade-leave-active {
  transition: opacity 0.2s ease;
}

.mask-fade-enter-from,
.mask-fade-leave-to {
  opacity: 0;
}
</style>
