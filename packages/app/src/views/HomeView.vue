<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { REPO_URL } from '../constants/repo'
import { useDelayedFlag } from '../composables/use-delayed-flag'
import { useEnvironmentCheck } from '../composables/useEnvironmentCheck'
import AppIcon from '../components/ui/AppIcon.vue'
import ProjectLoadProgress from '../components/project/ProjectLoadProgress.vue'
import BrowserUnsupportedView from './BrowserUnsupportedView.vue'
import type { RecentProject } from '@novai/core/types/project'

const router = useRouter()
const projectStore = useProjectStore()
const { report: environmentReport } = useEnvironmentCheck()
const showCreateDialog = ref(false)
const projectPendingDelete = ref<RecentProject | null>(null)
const newProjectName = ref('')
const isCreating = ref(false)
const isDeleting = ref(false)
const shouldDeleteDirectory = ref(false)

/**
 * 打开类动作（恢复、打开、新建）持续超过 300 毫秒才显示进度面板：桌面端基本在这个时间内完成，不闪现。
 * 置灰与各处理函数开头的守卫从动作一开始就生效，不等这 300 毫秒。
 */
const isOpenDelayed = useDelayedFlag(computed(() => projectStore.isOpenLoading))

/**
 * 原操作附近的黄色轻提醒（交互优化计划 §5）：取消与待授权不是错误，不进红色错误区。
 * 取消/无记录类 3 秒后自动淡出；授权提醒常驻，提供「重新授权」，重新执行原操作时被新提醒替换。
 */
const NOTICE_AUTO_DISMISS_MS = 3000
const noticeVisible = ref(false)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => projectStore.notice,
  (value) => {
    if (noticeTimer) {
      clearTimeout(noticeTimer)
      noticeTimer = null
    }

    if (!value) {
      noticeVisible.value = false
      return
    }

    noticeVisible.value = true

    if (value.kind !== 'permission') {
      noticeTimer = setTimeout(() => {
        noticeTimer = null
        noticeVisible.value = false
        projectStore.dismissNotice()
      }, NOTICE_AUTO_DISMISS_MS)
    }
  },
)

onBeforeUnmount(() => {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
})

function dismissHomeNotice() {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }

  noticeVisible.value = false
  projectStore.dismissNotice()
}

function handleNoticeRetry() {
  const value = projectStore.notice
  if (!value || value.kind !== 'permission' || !value.retryTarget) return

  if (value.retryTarget === 'last') {
    void handleRestoreProject()
    return
  }

  void handleSelectProject(value.retryTarget)
}

onMounted(async () => {
  // 环境不达标时首页整页替换为不可用提示，最近项目等数据没有加载的必要。
  if (!environmentReport.usable) return
  await projectStore.loadLastProjectSummary()
  await projectStore.loadRecentProjects()
})

async function handleOpenProject() {
  if (projectStore.isOpenLoading) return

  const project = await projectStore.openExistingProject()
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

async function handleRestoreProject() {
  if (projectStore.isOpenLoading) return

  const project = await projectStore.restoreLastOpenedProject()
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

async function handleCreateProject() {
  if (!newProjectName.value.trim() || isCreating.value || projectStore.isOpenLoading) return

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
  if (projectStore.isOpenLoading) return

  const project = await projectStore.openRecentProject(projectId)
  if (project) {
    router.push(`/project/${project.id}`)
  }
}

function handleAskDeleteProject(project: RecentProject) {
  if (projectStore.isOpenLoading || isDeleting.value) return

  projectPendingDelete.value = project
  shouldDeleteDirectory.value = false
}

/** 新建对话框的关闭入口（遮罩点击与「取消」共用）：创建进行中不可关闭。 */
function closeCreateDialog() {
  if (isCreating.value) return

  showCreateDialog.value = false
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
  <BrowserUnsupportedView v-if="!environmentReport.usable" :report="environmentReport" />
  <div v-else class="flex h-dvh flex-col bg-gray-50">
    <!-- 顶栏 -->
    <header class="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
      <div class="flex items-center gap-3">
        <!-- 品牌 mark：翻开的书 + 灯泡（与 assets/logo.svg 同款几何） -->
        <svg class="h-7 w-7" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="home-mark-acc" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#6366F1" />
              <stop offset="1" stop-color="#06B6D4" />
            </linearGradient>
          </defs>
          <g stroke="url(#home-mark-acc)" stroke-width="2" stroke-linecap="round">
            <path d="M 13 10 L 10.5 7.5" />
            <path d="M 35 10 L 37.5 7.5" />
          </g>
          <!-- 竖直光芒用 rect 填充：零宽 bbox 的直线描边吃不到 objectBoundingBox 渐变 -->
          <rect x="23" y="3" width="2" height="3" rx="1" fill="url(#home-mark-acc)" />
          <circle cx="24" cy="14.5" r="5" fill="url(#home-mark-acc)" />
          <rect x="21.5" y="19.5" width="5" height="1.8" rx="0.9" fill="url(#home-mark-acc)" />
          <rect x="22.2" y="22.4" width="3.6" height="1.6" rx="0.8" fill="url(#home-mark-acc)" />
          <path fill="#18181B" d="M 22.6 26 C 18 22.4, 10.5 21.4, 5 23.2 L 5 41 C 10.5 39.2, 18 40.2, 22.6 43.8 Z" />
          <path fill="#18181B" d="M 25.4 26 C 30 22.4, 37.5 21.4, 43 23.2 L 43 41 C 37.5 39.2, 30 40.2, 25.4 43.8 Z" />
        </svg>
        <h1 class="text-xl font-bold text-gray-900">NovAI（诺艾）</h1>
        <span class="text-sm text-gray-500">AI 小说创作助手</span>
      </div>
      <a
        :href="REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub 仓库"
        title="GitHub 仓库"
        class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
      >
        <svg class="h-5 w-5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      </a>
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

        <!--
          恢复、打开进行中且超过 300 毫秒：在这个位置换成进度面板（新建的进度面板在对话框内）。
          不足 300 毫秒（桌面端的常态）不闪现，横幅照常显示。
        -->
        <ProjectLoadProgress
          v-if="isOpenDelayed && projectStore.loadProgress && projectStore.loadProgress.action !== 'create'"
          class="mb-6"
          :progress="projectStore.loadProgress"
        />
        <!-- 恢复上次项目提示 -->
        <div
          v-else-if="projectStore.lastProjectSummary"
          class="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4"
        >
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-blue-900">上次打开的项目</p>
              <p class="text-sm text-blue-700">{{ projectStore.lastProjectSummary.name }}</p>
            </div>
            <button
              class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
              :disabled="projectStore.isOpenLoading"
              @click="handleRestoreProject"
            >
              恢复项目
            </button>
          </div>
        </div>

        <!-- 操作按钮（黄色轻提醒悬浮在按钮行下方，不推移页面内容） -->
        <div class="relative mb-6 flex gap-3">
          <button
            class="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-900"
            :disabled="projectStore.isOpenLoading"
            @click="showCreateDialog = true"
          >
            <AppIcon name="plus" :size="16" class="h-4 w-4" />
            新建项目
          </button>
          <button
            class="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
            :disabled="projectStore.isOpenLoading"
            @click="handleOpenProject"
          >
            <AppIcon name="folder-open" :size="16" class="h-4 w-4" />
            打开项目
          </button>

          <Transition name="home-notice">
            <div
              v-if="noticeVisible && projectStore.notice"
              class="absolute left-0 top-full z-20 mt-2 flex max-w-xl items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 shadow-sm"
              role="status"
              data-testid="home-action-notice"
            >
              <AppIcon name="triangle-alert" :size="16" class="mt-0.5 text-amber-500" />
              <p class="min-w-0 text-sm leading-5 text-amber-800">
                {{ projectStore.notice.message }}
              </p>
              <button
                v-if="projectStore.notice.kind === 'permission' && projectStore.notice.retryTarget"
                class="ml-1 shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
                data-testid="home-notice-retry"
                @click="handleNoticeRetry"
              >
                重新授权
              </button>
              <button
                v-if="projectStore.notice.kind === 'permission'"
                class="ml-0.5 shrink-0 rounded p-0.5 text-amber-500 transition-colors hover:bg-amber-100 hover:text-amber-700"
                aria-label="关闭提醒"
                @click="dismissHomeNotice"
              >
                <AppIcon name="x" :size="14" />
              </button>
            </div>
          </Transition>
        </div>

        <!-- 项目列表 -->
        <div v-if="projectStore.recentProjects.length > 0">
          <h2 class="mb-3 text-sm font-medium text-gray-500">最近项目</h2>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="project in projectStore.recentProjects"
              :key="project.id"
              class="group rounded-lg border border-gray-200 bg-white p-4 transition-all"
              :class="projectStore.isOpenLoading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-gray-300 hover:shadow-sm'"
              role="button"
              :aria-label="`打开项目 ${project.name}`"
              :aria-disabled="projectStore.isOpenLoading"
              @click="handleSelectProject(project.id)"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="truncate font-medium text-gray-900">{{ project.name }}</h3>
                  <p class="mt-1 text-sm text-gray-500">
                    {{ project.chapterCount }} 章<span class="mx-1.5 text-gray-300">·</span>{{ project.elementCount }} 个要素
                  </p>
                </div>
                <button
                  class="rounded-md p-1.5 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 group-hover:opacity-100 disabled:pointer-events-none"
                  title="移除最近项目"
                  :disabled="projectStore.isOpenLoading"
                  @click.stop="handleAskDeleteProject(project)"
                >
                  <AppIcon name="trash" :size="16" class="h-4 w-4" />
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
          <AppIcon name="book-open" :size="48" class="mb-4 h-12 w-12 text-gray-400" />
          <p class="mb-2 text-lg font-medium text-gray-900">欢迎使用 NovAI</p>
          <p class="text-sm text-gray-500">点击「新建项目」开始你的第一部小说</p>
        </div>
      </div>
    </main>

    <!-- 新建项目对话框 -->
    <div
      v-if="showCreateDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="closeCreateDialog"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 class="mb-4 text-lg font-semibold text-gray-900">新建项目</h2>
        <div class="mb-4">
          <label class="mb-1 block text-sm font-medium text-gray-700">项目名称</label>
          <input
            v-model="newProjectName"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="输入小说项目名称"
            :disabled="isCreating"
            @keyup.enter="handleCreateProject"
          />
        </div>
        <!-- 创建超过 300 毫秒才出现；创建期间对话框不可关闭 -->
        <ProjectLoadProgress
          v-if="isCreating && isOpenDelayed && projectStore.loadProgress"
          class="mb-4"
          :progress="projectStore.loadProgress"
        />
        <div class="flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
            :disabled="isCreating"
            @click="closeCreateDialog"
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

<style scoped>
.home-notice-enter-active,
.home-notice-leave-active {
  transition:
    opacity 200ms ease,
    transform 200ms ease;
}

.home-notice-enter-from,
.home-notice-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
