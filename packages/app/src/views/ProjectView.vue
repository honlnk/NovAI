<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import { useToast } from '../composables/useToast'
import FileTreeSidebar from '../components/layout/FileTreeSidebar.vue'
import ChatPanel from '../components/layout/ChatPanel.vue'
import ContentPanel from '../components/layout/ContentPanel.vue'
import Toast from '../components/ui/Toast.vue'
import FirstTimeGuide from '../components/ui/FirstTimeGuide.vue'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const chatStore = useChatStore()
const toast = useToast()

const projectId = computed(() => route.params.id as string)
const isSidebarOpen = ref(true)
const isContentPanelOpen = ref(false)
const isMobileSidebarOpen = ref(false)
const showGuide = ref(false)

onMounted(async () => {
  // 如果没有当前项目，尝试恢复
  if (!projectStore.currentProject) {
    await projectStore.loadLastProjectSummary()
    const restored = await projectStore.restoreLastOpenedProject()
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

// 监听文件变更，自动刷新文件树
watch(
  () => chatStore.changedFiles.length,
  async (newLength, oldLength) => {
    if (newLength > oldLength && projectStore.currentProject) {
      await projectStore.refreshTree()
      toast.success('文件树已更新')
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

function handleOpenSettings() {
  router.push(`/project/${projectId.value}/settings`)
}

async function handleSelectFile(path: string) {
  await projectStore.openFile(path)
  isContentPanelOpen.value = true
}

async function handleRefreshTree() {
  await projectStore.refreshTree()
  toast.success('文件树已刷新')
}

function toggleSidebar() {
  isSidebarOpen.value = !isSidebarOpen.value
}

function toggleContentPanel() {
  isContentPanelOpen.value = !isContentPanelOpen.value
}

function toggleMobileSidebar() {
  isMobileSidebarOpen.value = !isMobileSidebarOpen.value
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
  <div class="flex h-screen bg-white">
    <!-- 移动端侧边栏遮罩 -->
    <div
      v-if="isMobileSidebarOpen"
      class="fixed inset-0 z-40 bg-black/50 lg:hidden"
      @click="isMobileSidebarOpen = false"
    />

    <!-- 左侧文件树 -->
    <FileTreeSidebar
      :is-open="isSidebarOpen"
      :is-mobile-open="isMobileSidebarOpen"
      :project="projectStore.currentProject"
      :active-file-path="projectStore.activeFile?.path"
      @back-to-home="handleBackToHome"
      @open-settings="handleOpenSettings"
      @close-mobile="isMobileSidebarOpen = false"
      @select-file="handleSelectFile"
      @refresh-tree="handleRefreshTree"
    />

    <!-- 中间对话面板 -->
    <ChatPanel
      :project-id="projectId"
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
      :file="projectStore.activeFile"
      @close="isContentPanelOpen = false"
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
