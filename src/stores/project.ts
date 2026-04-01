import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createProject,
  findFirstReadableFile,
  isFileSystemAccessSupported,
  openProject,
  readProjectFile,
  rescanProject,
} from '../core/fs/project-fs'
import type { ProjectFileContent, ProjectSnapshot, RecentProject } from '../types/project'

export const useProjectStore = defineStore('project', () => {
  const currentProject = ref<ProjectSnapshot | null>(null)
  const recentProjects = ref<RecentProject[]>([])
  const activeFile = ref<ProjectFileContent | null>(null)
  const isBusy = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('等待选择小说项目')

  const isReady = computed(() => currentProject.value !== null)

  async function createNewProject(projectName: string) {
    return runProjectAction(async () => {
      const snapshot = await createProject(projectName)
      setCurrentProject(snapshot)
      statusMessage.value = `已创建项目「${snapshot.name}」`
      return snapshot
    })
  }

  async function openExistingProject() {
    return runProjectAction(async () => {
      const snapshot = await openProject()
      setCurrentProject(snapshot)
      statusMessage.value = `已打开项目「${snapshot.name}」`
      return snapshot
    })
  }

  async function openFile(path: string) {
    if (!currentProject.value) {
      return null
    }

    errorMessage.value = ''

    try {
      activeFile.value = await readProjectFile(currentProject.value, path)
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
      currentProject.value.tree = await rescanProject(currentProject.value)
      statusMessage.value = '文件树已刷新'
    } catch (error) {
      errorMessage.value = toMessage(error, '刷新文件树失败')
    }
  }

  function setCurrentProject(snapshot: ProjectSnapshot) {
    currentProject.value = snapshot
    recentProjects.value = [
      snapshot.metadata,
      ...recentProjects.value.filter((item) => item.id !== snapshot.metadata.id),
    ].slice(0, 8)

    const firstFilePath = findFirstReadableFile(snapshot.tree)
    if (firstFilePath) {
      void openFile(firstFilePath)
    } else {
      activeFile.value = null
    }
  }

  async function runProjectAction<T>(action: () => Promise<T>) {
    errorMessage.value = ''

    if (!isFileSystemAccessSupported()) {
      errorMessage.value = '当前浏览器不支持 File System Access API，请使用 Chromium 内核浏览器。'
      return null
    }

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
    isReady,
    recentProjects,
    statusMessage,
    createNewProject,
    openExistingProject,
    openFile,
    refreshTree,
  }
})

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
