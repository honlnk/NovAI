<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import { useIndexStore } from '../stores/index'
import { usePlanStore } from '../stores/plan'
import { useToast } from '../composables/useToast'
import ActivityBar from '../components/layout/ActivityBar.vue'
import CategoryPanel from '../components/layout/CategoryPanel.vue'
import ChatPanel from '../components/layout/ChatPanel.vue'
import ContentPanel from '../components/layout/ContentPanel.vue'
import FilePanelBody from '../components/layout/FilePanelBody.vue'
import IndexStatusBar from '../components/layout/IndexStatusBar.vue'
import PlanBoardPanel from '../components/plan/PlanBoardPanel.vue'
import PlanDetailPanel from '../components/plan/PlanDetailPanel.vue'
import PlanCreatePanel from '../components/plan/PlanCreatePanel.vue'
import SettingsModal from '../components/settings/SettingsModal.vue'
import RagIndexModal from '../components/rag/RagIndexModal.vue'
import Toast from '../components/ui/Toast.vue'
import FirstTimeGuide from '../components/ui/FirstTimeGuide.vue'
import type { Category } from '../constants/category'
import type { ChangedFileView, PlanStatusView } from '@novai/core/services/types'
import { pickDirectoryChildren, resolveActiveFileEffect } from '../utils/file-tree'
import { panelCloseTarget, resolveWorkspacePanel } from '../utils/workspace-panel'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const chatStore = useChatStore()
const indexStore = useIndexStore()
const planStore = usePlanStore()
const toast = useToast()

const projectId = computed(() => route.params.id as string)
const activeCategory = ref<Category>('chapter')
const isCategoryOpen = ref(true)
const isMobileCategoryOpen = ref(false)
/** 普通文件面板展开偏好（跨分类保留；恢复规则见 workspace-panel） */
const isContentPanelOpen = ref(false)
/** 计划面板（详情/新建）展开偏好（跨分类保留；进入计划默认收起，点击卡片或新建后展开） */
const isPlanPanelOpen = ref(false)
const showGuide = ref(false)
const isSettingsOpen = ref(false)
const isRagOpen = ref(false)
/** 内容面板选中的引用，透传给 ChatPanel 显示 chip；切文件时清空 */
const selectionQuote = ref<{ path: string; name: string; text: string } | null>(null)
/** 内容面板空态提示（AI 删除了正打开的文件时置入，指向回收站去向；打开新文件时清空） */
const panelNotice = ref<{ name: string; trashPath?: string } | null>(null)

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

  // 初始化聊天会话（拉取历史列表，有历史则激活最近一条，否则新建）
  await chatStore.initSessions(projectId.value)

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
  indexStore.dispose()
})

// 监听文件变更，自动刷新分类面板数据
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (newLength > oldLength && projectStore.currentProject) {
      await projectStore.refreshTree()
      toast.success('文件列表已更新')
    }
  },
)

// AI 改动命中当前打开的文件时：重读新内容（预览/原始模式即时更新，编辑模式草稿是
// FilePanelBody 本地副本不受影响）；删除命中则清空面板——快照再留着就是幽灵文件
// （无删除标记，编辑保存还会复活它），清空后由空态提示回收站去向
watch(
  () => chatStore.lastFileChange,
  (record) => {
    if (!record) {
      return
    }
    const effect = resolveActiveFileEffect(projectStore.activeFile?.path, record.change)
    if (effect?.action === 'reload') {
      void projectStore.openFile(effect.path)
      return
    }
    if (effect?.action === 'clear') {
      const deleted = record.change.type === 'deleted' ? record.change : null
      panelNotice.value = {
        name: projectStore.activeFile?.name ?? '当前文件',
        trashPath: deleted?.trashPath,
      }
      projectStore.clearActiveFile()
    }
  },
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

async function handleSelectFile(path: string) {
  await projectStore.openFile(path)
  isContentPanelOpen.value = true
}

/**
 * 内容面板编辑模式保存：写盘后由 store 更新 activeFile（同步最新 updatedAt），
 * FilePanelBody 侧的草稿会因为 watch viewMode 不再触发而保持，但 isDirty 会
 * 因 file.content 更新而变 false，「未保存」标记自动消失。
 */
async function handleSaveFile(path: string, content: string) {
  const saved = await projectStore.saveFile(path, content)
  if (saved) {
    toast.success('已保存')
  } else {
    toast.error(projectStore.errorMessage || '保存失败')
  }
}

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

/** 进入计划分类时加载看板；切回其他分类恢复原对话与文件面板状态（面板偏好都在本组件 ref，天然保留） */
watch(activeCategory, async (category) => {
  if (category === 'plan' && projectStore.currentProject) {
    await planStore.loadBoard(projectId.value)
  }
})

/** 切换/关闭项目时清理上一个项目的计划板状态（含编辑会话）与面板展开偏好 */
watch(() => projectStore.currentProject?.id, () => {
  planStore.reset()
  isPlanPanelOpen.value = false
})

/** 右侧面板当前应展示的内容与可见性（文件 / 计划详情 / 新建互斥，规则见 workspace-panel） */
const workspacePanel = computed(() => resolveWorkspacePanel({
  category: activeCategory.value,
  isFilePanelOpen: isContentPanelOpen.value,
  hasFileContent: projectStore.activeFile !== null || panelNotice.value !== null,
  isPlanPanelOpen: isPlanPanelOpen.value,
  isCreateOpen: planStore.isCreateOpen,
  hasActiveCard: planStore.activeCard !== null,
}))

/** 面板关闭只影响可见性（§2.8）：按当前内容类型收敛对应分类的展开偏好，不清计划与草稿 */
function handleCloseContentPanel() {
  const target = panelCloseTarget(workspacePanel.value.kind)
  if (target === 'file') {
    isContentPanelOpen.value = false
  } else if (target === 'plan') {
    isPlanPanelOpen.value = false
  }
}

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

/** 左侧计划标题行的刷新入口（布局统一计划 D7）：忙碌态由 isLoading 承载并防重复 */
async function handlePlanRefresh() {
  if (!projectStore.currentProject) {
    return
  }
  await planStore.refreshBoard(projectId.value)
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

async function handlePlanMove(id: string, status: PlanStatusView, afterId: string | null) {
  if (!projectStore.currentProject) {
    return
  }
  const movingProjectId = projectId.value
  const ok = await planStore.moveCard(movingProjectId, id, status, afterId)
  if (projectId.value !== movingProjectId || projectStore.currentProject?.id !== movingProjectId) return
  if (!ok) {
    toast.error(planStore.actionError || '移动计划失败')
  }
}

async function handlePlanRemove(id: string) {
  if (!projectStore.currentProject) {
    return
  }
  const removingProjectId = projectId.value
  const ok = await planStore.removeCard(removingProjectId, id)
  if (projectId.value !== removingProjectId || projectStore.currentProject?.id !== removingProjectId) return
  if (ok) {
    toast.success('已移入回收站')
  } else {
    toast.error(planStore.actionError || '删除计划失败')
  }
}

async function handlePlanSaveDraft() {
  if (!projectStore.currentProject) {
    return
  }
  const savingProjectId = projectId.value
  const previousPath = planStore.activeCard?.sourcePath
  const ok = await planStore.saveDraft(savingProjectId)
  if (projectId.value !== savingProjectId || projectStore.currentProject?.id !== savingProjectId) return
  if (ok) {
    toast.success('已保存')
    // 切卡后仍以保存完成的原卡片为准，不能让当前卡片决定文件树是否刷新。
    const savedCard = planStore.lastSavedCard
    if (savedCard && savedCard.sourcePath !== previousPath) {
      await projectStore.refreshTree()
    }
  } else if (planStore.detailNotice) {
    toast.error(planStore.detailNotice.message)
  } else if (!planStore.conflictNotice) {
    toast.error(planStore.actionError || '保存失败')
  }
}

function selectCategory(category: Category) {
  activeCategory.value = category
  // 切换分类时确保面板展开
  isCategoryOpen.value = true
}

function toggleSidebar() {
  isCategoryOpen.value = !isCategoryOpen.value
}

function toggleContentPanel() {
  isContentPanelOpen.value = !isContentPanelOpen.value
}

function toggleMobileSidebar() {
  isMobileCategoryOpen.value = !isMobileCategoryOpen.value
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
      <!-- 移动端分类面板遮罩 -->
      <div
        v-if="isMobileCategoryOpen"
        class="fixed inset-0 z-40 bg-black/50 lg:hidden"
        @click="isMobileCategoryOpen = false"
      />

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
      />

      <!-- 分类面板（随 Activity Bar 切换） -->
      <CategoryPanel
        :active-category="activeCategory"
        :files="projectStore.currentProject?.files ?? []"
        :active-file-path="projectStore.activeFile?.path"
        :active-outline-path="activeOutlinePath"
        :sessions="chatStore.sessions"
        :active-session-id="chatStore.activeSessionId"
        :pending-confirmation-ids="chatStore.sessionsWithPendingConfirmations"
        :plan-cards="planRecentCards"
        :is-plan-loading="planStore.isLoading"
        :selected-plan-card-id="planStore.selectedCardId"
        :pending-question-ids="chatStore.sessionsWithPendingQuestions"
        :is-open="isCategoryOpen"
        :is-mobile-open="isMobileCategoryOpen"
        @select-file="handleSelectFile"
        @change-outline="handleChangeOutline"
        @close-mobile="isMobileCategoryOpen = false"
        @select-session="(sessionId) => chatStore.selectSession(projectId, sessionId)"
        @create-session="chatStore.createNewSession(projectId)"
        @rename-session="(sessionId, title) => chatStore.renameSession(projectId, sessionId, title)"
        @delete-session="(sessionId) => chatStore.deleteSession(projectId, sessionId)"
        @open-plan-board="selectCategory('plan')"
        @refresh-plan="handlePlanRefresh"
        @open-plan-create="handleOpenPlanCreate"
        @open-plan-card="(id) => { selectCategory('plan'); handleOpenPlanCard(id) }"
      />

      <!-- 中间主内容区：计划分类显示看板（始终保留），其余分类为对话 -->
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
        @toggle-on-hold="planStore.showOnHold = !planStore.showOnHold"
        @toggle-sidebar="toggleSidebar"
        @toggle-mobile-sidebar="toggleMobileSidebar"
        @toggle-content-panel="handleTogglePlanPanel"
      />
      <ChatPanel
        v-else
        :project-id="projectId"
        :is-sidebar-open="isCategoryOpen"
        :is-content-panel-open="isContentPanelOpen"
        :quote="selectionQuote"
        :outlines="outlineList"
        :active-outline-path="activeOutlinePath"
        @toggle-sidebar="toggleSidebar"
        @toggle-content-panel="toggleContentPanel"
        @toggle-mobile-sidebar="toggleMobileSidebar"
        @clear-quote="handleClearQuote"
        @change-outline="handleChangeOutline"
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
        <!-- 普通文件：v-show 保挂载——文件编辑草稿是组件内状态，跨分类切换不得丢失（D12 §2.6-4）；
             kind 互斥由 workspacePanel 规则保证，计划两侧各自 v-if -->
        <FilePanelBody
          v-show="workspacePanel.kind === 'file'"
          :file="projectStore.activeFile"
          :notice="panelNotice"
          @close="handleCloseContentPanel"
          @save="handleSaveFile"
          @select-quote="handleSelectQuote"
        />
        <!-- 计划详情 -->
        <PlanDetailPanel
          v-if="workspacePanel.kind === 'plan-detail' && planStore.activeCard"
          :active-card="planStore.activeCard"
          :draft-body="planStore.draftBody"
          :draft-title="planStore.draftTitle"
          :detail-mode="planStore.detailMode"
          :is-saving="planStore.isSaving"
          :conflict-notice="planStore.conflictNotice"
          :action-error="planStore.actionError"
          :has-unsaved-changes="planStore.hasUnsavedChanges"
          @close="handleCloseContentPanel"
          @update-draft="planStore.updateDraft"
          @update-draft-title="planStore.updateDraftTitle"
          @set-detail-mode="planStore.setDetailMode"
          @save-draft="handlePlanSaveDraft"
          @reload-from-conflict="planStore.reloadFromConflict(projectId)"
          @keep-draft="planStore.keepDraft()"
          @move-card="handlePlanMove"
          @remove-card="handlePlanRemove"
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

    <!-- Toast 提示 -->
    <Toast
      v-for="t in toast.toasts.value"
      :key="t.id"
      :message="t.message"
      :type="t.type"
      @close="toast.remove(t.id)"
    />
  </div>
</template>
