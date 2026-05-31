<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import FileTreeSidebar from '../components/layout/FileTreeSidebar.vue'
import ChatPanel from '../components/layout/ChatPanel.vue'
import ContentPanel from '../components/layout/ContentPanel.vue'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const chatStore = useChatStore()

const projectId = computed(() => route.params.id as string)
const isSidebarOpen = ref(true)
const isContentPanelOpen = ref(false)
const isMobileSidebarOpen = ref(false)

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
})

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
    />

    <!-- 右侧内容面板 -->
    <ContentPanel
      :is-open="isContentPanelOpen"
      :file="projectStore.activeFile"
      @close="isContentPanelOpen = false"
    />
  </div>
</template>
