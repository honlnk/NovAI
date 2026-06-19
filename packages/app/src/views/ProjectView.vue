<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import { useToast } from '../composables/useToast'
import ActivityBar from '../components/layout/ActivityBar.vue'
import CategoryPanel from '../components/layout/CategoryPanel.vue'
import ChatPanel from '../components/layout/ChatPanel.vue'
import ContentPanel from '../components/layout/ContentPanel.vue'
import SettingsModal from '../components/settings/SettingsModal.vue'
import Toast from '../components/ui/Toast.vue'
import FirstTimeGuide from '../components/ui/FirstTimeGuide.vue'
import type { Category } from '../constants/category'
import { pickDirectoryChildren } from '../utils/file-tree'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const chatStore = useChatStore()
const toast = useToast()

const projectId = computed(() => route.params.id as string)
const activeCategory = ref<Category>('chapter')
const isCategoryOpen = ref(true)
const isMobileCategoryOpen = ref(false)
const isContentPanelOpen = ref(false)
const showGuide = ref(false)
const isSettingsOpen = ref(false)
/** 内容面板选中的引用，透传给 ChatPanel 显示 chip；切文件时清空 */
const selectionQuote = ref<{ path: string; name: string; text: string } | null>(null)

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

/** 从 currentProject 取配置里的激活场景路径（分类面板需读取它做高亮联动） */
const activeScenePromptPath = computed(() => {
  return projectStore.currentProject?.config.settings.activeScenePromptPath ?? null
})

/** 场景提示词列表（prompts/scenes/*.md，拉平），供 ChatPanel 的 @ 指令选择（R4） */
const sceneList = computed(() => {
  const files = projectStore.currentProject?.files ?? []
  return pickDirectoryChildren(files, 'prompts/scenes').filter(
    (n) => n.kind === 'file' && n.path.endsWith('.md'),
  )
})

/** 当前激活场景的显示名（去 .md 扩展名），ChatPanel 的场景 chip 展示用（R4） */
const activeSceneName = computed(() => {
  if (!activeScenePromptPath.value) return null
  const node = sceneList.value.find((n) => n.path === activeScenePromptPath.value)
  return node ? node.name.replace(/\.md$/i, '') : null
})

/** 章节列表（chapters/*.txt|.md），供 ChatPanel 的 /提取要素 指令多选（R6） */
const chapterList = computed(() => {
  const files = projectStore.currentProject?.files ?? []
  return pickDirectoryChildren(files, 'chapters').filter(
    (n) => n.kind === 'file' && /\.(txt|md)$/i.test(n.name),
  )
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

  // 初始化聊天会话
  await chatStore.createSession(projectId.value)

  // 检查是否需要显示首次引导
  if (projectStore.currentProject) {
    const config = projectStore.currentProject.config
    if (!config.llm?.apiKey) {
      showGuide.value = true
    }
  }
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

// 监听运行状态，显示 Toast 提示
watch(
  () => chatStore.runStatus,
  (status) => {
    if (status.includes('执行完成')) {
      toast.success(status)
    } else if (status.includes('失败') || status.includes('错误')) {
      toast.error(status)
    }
  },
)

// 切换文件时清空选中引用（引用绑定当前文件，避免跨文件残留）
watch(
  () => projectStore.activeFile?.path,
  () => {
    selectionQuote.value = null
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

async function handleSelectFile(path: string) {
  await projectStore.openFile(path)
  isContentPanelOpen.value = true
}

/**
 * 内容面板编辑模式保存：写盘后由 store 更新 activeFile（同步最新 updatedAt），
 * ContentPanel 侧的草稿会因为 watch viewMode 不再触发而保持，但 isDirty 会
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

async function handleChangeScene(path: string | null) {
  const saved = await projectStore.changeActiveScenePromptPath(projectId.value, path)
  if (saved) {
    toast.info(path ? '已切换场景提示词，新建会话后生效' : '已关闭场景提示词，新建会话后生效')
  } else {
    toast.error(projectStore.errorMessage || '切换场景提示词失败')
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

async function handleElementsWritten() {
  await projectStore.refreshTree()
  toast.success('要素文件已写入，RAG 索引已标记为过期')
}
</script>

<template>
  <div class="flex h-screen bg-white">
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
    />

    <!-- 分类面板（随 Activity Bar 切换） -->
    <CategoryPanel
      :active-category="activeCategory"
      :files="projectStore.currentProject?.files ?? []"
      :active-file-path="projectStore.activeFile?.path"
      :active-scene-prompt-path="activeScenePromptPath"
      :is-open="isCategoryOpen"
      :is-mobile-open="isMobileCategoryOpen"
      @select-file="handleSelectFile"
      @change-scene="handleChangeScene"
      @close-mobile="isMobileCategoryOpen = false"
    />

    <!-- 中间对话面板 -->
    <ChatPanel
      :project-id="projectId"
      :is-sidebar-open="isCategoryOpen"
      :is-content-panel-open="isContentPanelOpen"
      :quote="selectionQuote"
      :scenes="sceneList"
      :active-scene-prompt-path="activeScenePromptPath"
      :active-scene-name="activeSceneName"
      :chapters="chapterList"
      @toggle-sidebar="toggleSidebar"
      @toggle-content-panel="toggleContentPanel"
      @toggle-mobile-sidebar="toggleMobileSidebar"
      @clear-quote="handleClearQuote"
      @change-scene="handleChangeScene"
      @elements-written="handleElementsWritten"
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

    <!-- 右侧内容面板 -->
    <ContentPanel
      :is-open="isContentPanelOpen"
      :project-id="projectId"
      :file="projectStore.activeFile"
      :width="contentPanelWidth"
      @close="isContentPanelOpen = false"
      @save="handleSaveFile"
      @select-quote="handleSelectQuote"
      @resize="contentPanelWidth = $event"
      @reset-width="contentPanelWidth = CONTENT_PANEL_DEFAULT"
    />

    <!-- 设置模态框（按需挂载：关闭时销毁，再次打开重新读取磁盘配置） -->
    <SettingsModal
      v-if="isSettingsOpen"
      :project-id="projectId"
      @close="isSettingsOpen = false"
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
