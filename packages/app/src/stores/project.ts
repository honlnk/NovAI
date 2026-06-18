import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  closeProject,
  createProject,
  deleteRecentProject,
  forgetLastProject,
  getLastProjectSummary,
  getRecentProjects,
  isProjectAccessSupported,
  openProject,
  refreshRecentProjectCounts,
  restoreRecentProject,
  restoreLastProject,
} from '@novai/core/services/project-service'
import {
  readFile,
  refreshFiles,
  writeFile,
} from '@novai/core/services/file-service'
import { updateConfig } from '@novai/core/services/settings-service'
import type {
  FileContentView,
  LastProjectSummaryView,
  ProjectConfigView,
  ProjectFileNodeView,
  ProjectView,
} from '@novai/core/services/types'
import type { RecentProject } from '@novai/core/types/project'

/**
 * 首屏计数刷新的并发开关。
 * onMounted 等场景可能多次触发 loadRecentProjects，用 module 级 flag 保证同一时刻只跑一次后台刷新。
 */
let isRefreshingCounts = false

export const useProjectStore = defineStore('project', () => {
  const currentProject = ref<ProjectView | null>(null)
  const recentProjects = ref<RecentProject[]>([])
  const activeFile = ref<FileContentView | null>(null)
  const lastProjectSummary = ref<LastProjectSummaryView | null>(null)
  const isBusy = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('等待选择小说项目')

  const isReady = computed(() => currentProject.value !== null)
  const isFileSystemSupported = computed(() => isProjectAccessSupported())

  async function createNewProject(projectName: string) {
    return runProjectAction(async () => {
      const project = await createProject(projectName)
      await setCurrentProject(project)
      statusMessage.value = `已创建项目「${project.name}」`
      return project
    })
  }

  async function openExistingProject() {
    return runProjectAction(async () => {
      const project = await openProject()
      await setCurrentProject(project)
      statusMessage.value = `已打开项目「${project.name}」`
      return project
    })
  }

  async function restoreLastOpenedProject() {
    return runProjectAction(async () => {
      const project = await restoreLastProject()

      if (!project) {
        statusMessage.value = '没有可恢复的上次项目，或目录权限尚未授权'
        return null
      }

      await setCurrentProject(project)
      statusMessage.value = `已恢复上次项目「${project.name}」`
      return project
    })
  }

  async function openRecentProject(projectId: string) {
    return runProjectAction(async () => {
      const project = await restoreRecentProject(projectId)

      if (!project) {
        statusMessage.value = '没有找到该最近项目，或目录权限尚未授权'
        return null
      }

      await setCurrentProject(project)
      statusMessage.value = `已打开最近项目「${project.name}」`
      return project
    })
  }

  async function loadLastProjectSummary() {
    try {
      lastProjectSummary.value = await getLastProjectSummary()
      return lastProjectSummary.value
    } catch (error) {
      errorMessage.value = toMessage(error, '读取最近项目记录失败')
      return null
    }
  }

  async function loadRecentProjects() {
    try {
      const summaries = await getRecentProjects()
      recentProjects.value = toRecentProjectsFromSummaries(summaries)
      refreshRecentProjectsInBackground()
      return recentProjects.value
    } catch (error) {
      errorMessage.value = toMessage(error, '读取最近项目列表失败')
      return []
    }
  }

  /**
   * 把 service 层返回的最近项目摘要映射成 store 内部结构。
   */
  function toRecentProjectsFromSummaries(summaries: LastProjectSummaryView[]): RecentProject[] {
    return summaries.map((summary) => ({
      id: summary.projectId,
      name: summary.name,
      updatedAt: summary.lastOpenedAt,
      chapterCount: summary.chapterCount,
      elementCount: summary.elementCount,
      wordCount: 0,
    }))
  }

  /**
   * 后台静默刷新最近项目的章节数/要素数。
   *
   * 解决「必须打开一遍才显示计数」：对已持有目录权限的项目重新扫描计数并回写。
   * 不阻塞首屏（loadRecentProjects 已用旧值先渲染），刷新完成后覆盖 store 触发重渲染。
   * 单次并发保护，避免 onMounted 重复触发。
   */
  async function refreshRecentProjectsInBackground() {
    if (isRefreshingCounts) {
      return
    }

    isRefreshingCounts = true
    try {
      const refreshedSummaries = await refreshRecentProjectCounts()
      // 刷新期间若用户已打开项目，避免覆盖 setCurrentProject 写入的更新数据：仅当
      // 当前 store 状态仍是列表（非空且未被清空）时回填。
      if (recentProjects.value.length > 0) {
        recentProjects.value = toRecentProjectsFromSummaries(refreshedSummaries)
      }
    } catch {
      // 后台刷新失败不影响首屏已有数据。
    } finally {
      isRefreshingCounts = false
    }
  }

  async function forgetLastOpenedProject() {
    return runProjectAction(async () => {
      await forgetLastProject()
      lastProjectSummary.value = null
      statusMessage.value = '已忘记上次项目记录'
    })
  }

  async function removeRecentProject(projectId: string, options: { deleteDirectory?: boolean } = {}) {
    return runProjectAction(async () => {
      await deleteRecentProject(projectId, options)
      recentProjects.value = recentProjects.value.filter((item) => item.id !== projectId)

      if (lastProjectSummary.value?.projectId === projectId) {
        lastProjectSummary.value = null
      }

      if (currentProject.value?.id === projectId) {
        currentProject.value = null
        activeFile.value = null
      }

      statusMessage.value = options.deleteDirectory
        ? '已移除最近项目记录并删除本地目录'
        : '已移除最近项目记录'

      return true
    })
  }

  async function closeCurrentProject() {
    if (!currentProject.value) {
      statusMessage.value = '当前没有打开的项目'
      return
    }

    const project = currentProject.value

    await runProjectAction(async () => {
      await closeProject(project.id)
      currentProject.value = null
      activeFile.value = null
      statusMessage.value = `已关闭项目「${project.name}」`
    })
  }

  async function openFile(path: string) {
    if (!currentProject.value) {
      return null
    }

    errorMessage.value = ''

    try {
      activeFile.value = await readFile(currentProject.value.id, path)
      return activeFile.value
    } catch (error) {
      errorMessage.value = toMessage(error, '读取文件失败')
      return null
    }
  }

  /**
   * 保存内容面板编辑模式的草稿到磁盘。
   * 写盘成功后更新 activeFile（同步最新 updatedAt），不刷新整个文件树
   *（文件树结构未变，仅内容更新）。
   */
  async function saveFile(path: string, content: string) {
    if (!currentProject.value) {
      return null
    }

    errorMessage.value = ''

    try {
      activeFile.value = await writeFile(currentProject.value.id, path, content)
      return activeFile.value
    } catch (error) {
      errorMessage.value = toMessage(error, '保存文件失败')
      return null
    }
  }

  async function refreshTree() {
    if (!currentProject.value) {
      return
    }

    errorMessage.value = ''

    try {
      currentProject.value = {
        ...currentProject.value,
        files: await refreshFiles(currentProject.value.id),
      }
      statusMessage.value = '文件树已刷新'
    } catch (error) {
      errorMessage.value = toMessage(error, '刷新文件树失败')
    }
  }

  async function setCurrentProject(project: ProjectView) {
    currentProject.value = project
    recentProjects.value = [
      toRecentProject(project),
      ...recentProjects.value.filter((item) => item.id !== project.id),
    ].slice(0, 8)

    const firstFilePath = project.activeFilePath ?? findFirstReadableFile(project.files)
    if (firstFilePath) {
      await openFile(firstFilePath)
    } else {
      activeFile.value = null
    }
  }

  function updateCurrentProjectConfig(config: ProjectConfigView) {
    if (!currentProject.value) {
      return
    }

    currentProject.value = {
      ...currentProject.value,
      name: config.project.name || currentProject.value.rootName,
      config,
    }
  }

  /**
   * 切换当前激活的场景提示词。
   *
   * 这条 action 解决了一个已知坑点：直接调 settingsStore.saveConfig 只会更新 settingsStore
   * 自己的 config 副本，不会同步到 projectStore.currentProject.config（后者是 setCurrentProject
   * 那一刻生成的快照）。分类面板读取的是 projectStore 侧，因此这里在写盘成功后显式调
   * updateCurrentProjectConfig 同步本地，避免 UI 显示过期数据。
   *
   * @param path 场景提示词路径，传 null 表示关闭场景
   */
  async function changeActiveScenePromptPath(projectId: string, path: string | null) {
    errorMessage.value = ''

    try {
      const savedConfig = await updateConfig(projectId, {
        settings: { activeScenePromptPath: path },
      })
      updateCurrentProjectConfig(savedConfig)
      statusMessage.value = path
        ? '已切换场景提示词，新建会话后生效'
        : '已关闭场景提示词，新建会话后生效'
      return savedConfig
    } catch (error) {
      errorMessage.value = toMessage(error, '切换场景提示词失败')
      return null
    }
  }

  async function runProjectAction<T>(action: () => Promise<T>) {
    errorMessage.value = ''
    isBusy.value = true

    try {
      return await action()
    } catch (error) {
      errorMessage.value = toMessage(error, '项目操作失败')
      return null
    } finally {
      isBusy.value = false
    }
  }

  return {
    activeFile,
    currentProject,
    errorMessage,
    isBusy,
    isFileSystemSupported,
    isReady,
    lastProjectSummary,
    recentProjects,
    statusMessage,
    changeActiveScenePromptPath,
    closeCurrentProject,
    createNewProject,
    forgetLastOpenedProject,
    loadLastProjectSummary,
    loadRecentProjects,
    openExistingProject,
    openFile,
    openRecentProject,
    refreshTree,
    removeRecentProject,
    restoreLastOpenedProject,
    saveFile,
    updateCurrentProjectConfig,
  }
})

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}

function findFirstReadableFile(tree: ProjectFileNodeView[]): string | null {
  const stack = [...tree]

  while (stack.length > 0) {
    const current = stack.shift()

    if (!current) {
      continue
    }

    if (current.kind === 'file' && /\.(md|json|txt)$/i.test(current.name)) {
      return current.path
    }

    if (current.children?.length) {
      stack.unshift(...current.children)
    }
  }

  return null
}

function toRecentProject(project: ProjectView): RecentProject {
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.config.project.updatedAt,
    chapterCount: countChapterFiles(project.files),
    elementCount: countElementFiles(project.files),
    wordCount: 0,
  }
}

function countChapterFiles(nodes: ProjectFileNodeView[]): number {
  return nodes.reduce((total, node) => {
    if (node.kind === 'file') {
      return node.path.startsWith('chapters/') && /\.(txt|md)$/i.test(node.name)
        ? total + 1
        : total
    }

    return total + countChapterFiles(node.children ?? [])
  }, 0)
}

function countElementFiles(nodes: ProjectFileNodeView[]): number {
  return nodes.reduce((total, node) => {
    if (node.kind === 'file') {
      return node.path.startsWith('elements/') && /\.(md|json|txt)$/i.test(node.name)
        ? total + 1
        : total
    }

    return total + countElementFiles(node.children ?? [])
  }, 0)
}
