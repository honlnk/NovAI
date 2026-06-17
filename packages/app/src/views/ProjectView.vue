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
import Toast from '../components/ui/Toast.vue'
import FirstTimeGuide from '../components/ui/FirstTimeGuide.vue'
import type { Category } from '../constants/category'

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

/** 从 currentProject 取配置里的激活场景路径（分类面板需读取它做高亮联动） */
const activeScenePromptPath = computed(() => {
  return projectStore.currentProject?.config.settings.activeScenePromptPath ?? null
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

function handleBackToHome() {
  projectStore.closeCurrentProject()
  router.push('/')
}

/**
 * 打开设置。
 * R1 阶段设置模态框尚未实现（R2 的工作），这里先给提示，保留入口。
 */
function handleOpenSettings() {
  toast.info('设置入口将在下一阶段改为弹窗')
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
      @toggle-sidebar="toggleSidebar"
      @toggle-content-panel="toggleContentPanel"
      @toggle-mobile-sidebar="toggleMobileSidebar"
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
      @close="isContentPanelOpen = false"
      @elements-written="handleElementsWritten"
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
