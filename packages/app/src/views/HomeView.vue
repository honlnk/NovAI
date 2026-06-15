<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import type { RecentProject } from '@novai/core/types/project'

const router = useRouter()
const projectStore = useProjectStore()
const showCreateDialog = ref(false)
const projectPendingDelete = ref<RecentProject | null>(null)
const newProjectName = ref('')
const isCreating = ref(false)
const isDeleting = ref(false)
const shouldDeleteDirectory = ref(false)

onMounted(async () => {
  await projectStore.loadLastProjectSummary()
  await projectStore.loadRecentProjects()
})

async function handleOpenProject() {
  const project = await projectStore.openExistingProject()
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

async function handleRestoreProject() {
  const project = await projectStore.restoreLastOpenedProject()
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

async function handleCreateProject() {
  if (!newProjectName.value.trim()) return

  isCreating.value = true
  try {
    const project = await projectStore.createNewProject(newProjectName.value.trim())
    if (project) {
      showCreateDialog.value = false
      newProjectName.value = ''
      router.push(`/project/${project.id}`)
    }
  } finally {
    isCreating.value = false
  }
}

async function handleSelectProject(projectId: string) {
  const project = await projectStore.openRecentProject(projectId)
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

function handleAskDeleteProject(project: RecentProject) {
  projectPendingDelete.value = project
  shouldDeleteDirectory.value = false
}

function handleCancelDeleteProject() {
  if (isDeleting.value) return

  projectPendingDelete.value = null
  shouldDeleteDirectory.value = false
}

async function handleConfirmDeleteProject() {
  if (!projectPendingDelete.value) return

  isDeleting.value = true
  try {
    const removed = await projectStore.removeRecentProject(projectPendingDelete.value.id, {
      deleteDirectory: shouldDeleteDirectory.value,
    })

    if (!removed) {
      return
    }

    projectPendingDelete.value = null
    shouldDeleteDirectory.value = false
    await projectStore.loadLastProjectSummary()
  } finally {
    isDeleting.value = false
  }
}
</script>

<template>
  <div class="flex h-screen flex-col bg-gray-50">
    <!-- 顶栏 -->
    <header class="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-900">NovAI（诺艾）</h1>
        <span class="text-sm text-gray-500">AI 小说创作助手</span>
      </div>
    </header>

    <!-- 主体 -->
    <main class="flex-1 overflow-y-auto p-6">
      <div class="mx-auto max-w-4xl">
        <div
          v-if="projectStore.errorMessage"
          class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {{ projectStore.errorMessage }}
        </div>

        <!-- 恢复上次项目提示 -->
        <div
          v-if="projectStore.lastProjectSummary"
          class="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4"
        >
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-blue-900">上次打开的项目</p>
              <p class="text-sm text-blue-700">{{ projectStore.lastProjectSummary.name }}</p>
            </div>
            <button
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              @click="handleRestoreProject"
            >
              恢复项目
            </button>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="mb-6 flex gap-3">
          <button
            class="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
            @click="showCreateDialog = true"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            新建项目
          </button>
          <button
            class="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="handleOpenProject"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
            </svg>
            打开项目
          </button>
        </div>

        <!-- 项目列表 -->
        <div v-if="projectStore.recentProjects.length > 0">
          <h2 class="mb-3 text-sm font-medium text-gray-500">最近项目</h2>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="project in projectStore.recentProjects"
              :key="project.id"
              class="group cursor-pointer rounded-lg border border-gray-200 bg-white p-4 transition-all hover:border-gray-300 hover:shadow-sm"
              @click="handleSelectProject(project.id)"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="truncate font-medium text-gray-900">{{ project.name }}</h3>
                  <p class="mt-1 text-sm text-gray-500">{{ project.chapterCount }} 章</p>
                </div>
                <button
                  class="rounded-md p-1.5 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 group-hover:opacity-100"
                  title="移除最近项目"
                  @click.stop="handleAskDeleteProject(project)"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 12a1 1 0 001 .93h6a1 1 0 001-.93l1-12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div
          v-else
          class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 py-16"
        >
          <svg class="mb-4 h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <p class="mb-2 text-lg font-medium text-gray-900">欢迎使用 NovAI</p>
          <p class="text-sm text-gray-500">点击「新建项目」开始你的第一部小说</p>
        </div>
      </div>
    </main>

    <!-- 新建项目对话框 -->
    <div
      v-if="showCreateDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showCreateDialog = false"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 class="mb-4 text-lg font-semibold text-gray-900">新建项目</h2>
        <div class="mb-4">
          <label class="mb-1 block text-sm font-medium text-gray-700">项目名称</label>
          <input
            v-model="newProjectName"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入小说项目名称"
            @keyup.enter="handleCreateProject"
          />
        </div>
        <div class="flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="showCreateDialog = false"
          >
            取消
          </button>
          <button
            class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            :disabled="!newProjectName.trim() || isCreating"
            @click="handleCreateProject"
          >
            {{ isCreating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除最近项目对话框 -->
    <div
      v-if="projectPendingDelete"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="handleCancelDeleteProject"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 class="mb-2 text-lg font-semibold text-gray-900">移除最近项目</h2>
        <p class="mb-4 text-sm text-gray-600">
          要从最近项目中移除「{{ projectPendingDelete.name }}」吗？
        </p>
        <label class="mb-5 flex items-start gap-3 rounded-lg border border-red-100 bg-red-50 p-3">
          <input
            v-model="shouldDeleteDirectory"
            class="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
            type="checkbox"
          />
          <span>
            <span class="block text-sm font-medium text-red-900">同步删除本地项目目录</span>
            <span class="mt-1 block text-sm text-red-700">勾选后会删除该项目文件夹及其中所有文件。</span>
          </span>
        </label>
        <div class="flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            :disabled="isDeleting"
            @click="handleCancelDeleteProject"
          >
            取消
          </button>
          <button
            class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            :disabled="isDeleting"
            @click="handleConfirmDeleteProject"
          >
            {{ isDeleting ? '处理中...' : '确认移除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
