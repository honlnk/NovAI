import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  closeProject,
  createProject,
  forgetLastProject,
  getLastProjectSummary,
  isProjectAccessSupported,
  openProject,
  restoreLastProject,
} from '../services/project-service'
import {
  readFile,
  refreshFiles,
} from '../services/file-service'
import type {
  FileContentView,
  LastProjectSummaryView,
  ProjectConfigView,
  ProjectFileNodeView,
  ProjectView,
} from '../services/types'
import type { RecentProject } from '../types/project'

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

  async function loadLastProjectSummary() {
    try {
      lastProjectSummary.value = await getLastProjectSummary()
      return lastProjectSummary.value
    } catch (error) {
      errorMessage.value = toMessage(error, '读取最近项目记录失败')
      return null
    }
  }

  async function forgetLastOpenedProject() {
    return runProjectAction(async () => {
      await forgetLastProject()
      lastProjectSummary.value = null
      statusMessage.value = '已忘记上次项目记录'
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
    closeCurrentProject,
    createNewProject,
    forgetLastOpenedProject,
    loadLastProjectSummary,
    openExistingProject,
    openFile,
    refreshTree,
    restoreLastOpenedProject,
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
    wordCount: 0,
  }
}

function countChapterFiles(nodes: ProjectFileNodeView[]): number {
  return nodes.reduce((total, node) => {
    if (node.kind === 'file') {
      return node.path.startsWith('chapters/') && node.name.endsWith('.md')
        ? total + 1
        : total
    }

    return total + countChapterFiles(node.children ?? [])
  }, 0)
}
