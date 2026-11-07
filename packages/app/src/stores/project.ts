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
  updateRecentProjectCounts,
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
import { ProjectPermissionRequiredError } from '@novai/core/types/project'
import type { ReasoningEffort } from '@novai/core/types/ai'
import type { PermissionPreset } from '@novai/core/types/project'
import type { RecentProject } from '@novai/core/types/project'

/**
 * 首屏计数刷新的并发开关。
 * onMounted 等场景可能多次触发 loadRecentProjects，用 module 级 flag 保证同一时刻只跑一次后台刷新。
 */
let isRefreshingCounts = false

/**
 * 项目操作的非失败反馈：用户主动取消、待重新授权、无记录等中性/提醒级信息。
 * 与 errorMessage（真实失败的红色错误）严格分级——取消与待授权不是错误（交互优化计划 §5）。
 */
export type ProjectActionNotice = {
  kind: 'cancelled' | 'permission' | 'info'
  message: string
  /** kind='permission' 时提供重新授权的重跑目标：'last'=上次项目，其余为最近项目 id */
  retryTarget?: string
}

export const useProjectStore = defineStore('project', () => {
  const currentProject = ref<ProjectView | null>(null)
  const recentProjects = ref<RecentProject[]>([])
  const activeFile = ref<FileContentView | null>(null)
  const lastProjectSummary = ref<LastProjectSummaryView | null>(null)
  const isBusy = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('等待选择小说项目')
  const notice = ref<ProjectActionNotice | null>(null)

  function dismissNotice() {
    notice.value = null
  }

  const isReady = computed(() => currentProject.value !== null)
  const isFileSystemSupported = computed(() => isProjectAccessSupported())

  async function createNewProject(projectName: string) {
    return runProjectAction(
      async () => {
        const project = await createProject(projectName)
        await setCurrentProject(project)
        statusMessage.value = `已创建项目「${project.name}」`
        return project
      },
      { cancelNotice: '未选择目录，项目未创建' },
    )
  }

  async function openExistingProject() {
    return runProjectAction(
      async () => {
        const project = await openProject()
        await setCurrentProject(project)
        statusMessage.value = `已打开项目「${project.name}」`
        return project
      },
      { cancelNotice: '未选择目录，项目未打开' },
    )
  }

  async function restoreLastOpenedProject() {
    return runProjectAction(
      async () => {
        const project = await restoreLastProject()

        if (!project) {
          notice.value = { kind: 'info', message: '没有可恢复的上次项目记录' }
          return null
        }

        await setCurrentProject(project)
        statusMessage.value = `已恢复上次项目「${project.name}」`
        return project
      },
      { permissionRetryTarget: 'last' },
    )
  }

  async function openRecentProject(projectId: string) {
    return runProjectAction(
      async () => {
        const project = await restoreRecentProject(projectId)

        if (!project) {
          notice.value = { kind: 'info', message: '没有找到该最近项目记录' }
          return null
        }

        await setCurrentProject(project)
        statusMessage.value = `已打开最近项目「${project.name}」`
        return project
      },
      { permissionRetryTarget: projectId },
    )
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

  /**
   * 清空内容面板当前打开的文件（不关项目）。
   *
   * 供「AI 删除了正打开的文件」场景调用：磁盘上文件已不存在，快照再留着就是
   * 幽灵文件（无删除标记，编辑保存还会复活它），由调用方负责给出空态提示。
   */
  function clearActiveFile() {
    activeFile.value = null
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
      await syncRecentProjectCounts()
      statusMessage.value = '文件树已刷新'
    } catch (error) {
      errorMessage.value = toMessage(error, '刷新文件树失败')
    }
  }

  /**
   * 文件树刷新后，把最新章节数/要素数同步到最近项目记录（内存 + IndexedDB 落盘）。
   *
   * 解决主页卡片计数陈旧：此前计数只在「打开项目」或「主页后台重扫（需目录授权存活）」
   * 时回写，AI 写完章节后若授权失效（如重启浏览器），主页显示的还是打开项目那一刻的旧值。
   * 现在文件树刷新（AI 写入、要素写入、章节整理的公共汇合点）当场回写，授权是否存活
   * 不再影响计数正确性。回写失败静默吞掉——计数是锦上添花，不能把文件树刷新报成失败。
   */
  async function syncRecentProjectCounts() {
    const project = currentProject.value

    if (!project) {
      return
    }

    const chapterCount = countChapterFiles(project.files)
    const elementCount = countElementFiles(project.files)

    recentProjects.value = recentProjects.value.map((item) =>
      item.id === project.id ? { ...item, chapterCount, elementCount } : item,
    )

    if (lastProjectSummary.value?.projectId === project.id) {
      lastProjectSummary.value = {
        ...lastProjectSummary.value,
        chapterCount,
        elementCount,
      }
    }

    try {
      await updateRecentProjectCounts(project.id, chapterCount, elementCount)
    } catch {
      // IndexedDB 写失败不影响刷新流程；主页后台重扫仍是兜底。
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
   * 切换当前激活的写作大纲。
   *
   * 这条 action 解决了一个已知坑点：直接调 settingsStore.saveConfig 只会更新 settingsStore
   * 自己的 config 副本，不会同步到 projectStore.currentProject.config（后者是 setCurrentProject
   * 那一刻生成的快照）。分类面板读取的是 projectStore 侧，因此这里在写盘成功后显式调
   * updateCurrentProjectConfig 同步本地，避免 UI 显示过期数据。
   *
   * @param path 大纲路径，传 null 表示关闭大纲。大纲随最新消息动态附带（W2 注入机制），
   *   切换/关闭在当前会话下一条消息即生效，无需新建会话。
   */
  async function changeActiveOutlinePath(projectId: string, path: string | null) {
    errorMessage.value = ''

    try {
      const savedConfig = await updateConfig(projectId, {
        settings: { activeOutlinePath: path },
      })
      updateCurrentProjectConfig(savedConfig)
      statusMessage.value = path
        ? '已切换写作大纲'
        : '已关闭写作大纲'
      return savedConfig
    } catch (error) {
      errorMessage.value = toMessage(error, '切换写作大纲失败')
      return null
    }
  }

  /**
   * 切换写工具权限档位（对话输入区与设置页共用写回链路）：
   * 写盘 + 同步 currentProject 快照，下一轮起按新档判定。
   */
  async function changePermissionPreset(projectId: string, preset: PermissionPreset) {
    errorMessage.value = ''

    try {
      const savedConfig = await updateConfig(projectId, {
        settings: { permissionPreset: preset },
      })
      updateCurrentProjectConfig(savedConfig)
      statusMessage.value = '已切换写工具权限档位，下一轮起生效'
      return savedConfig
    } catch (error) {
      errorMessage.value = toMessage(error, '切换权限档位失败')
      return null
    }
  }

  /**
   * 切换思考强度档位（对话输入区选择器写回链路，思考强度计划 D3，四档）：
   * 直接写回所选档位；未配置（字段缺省）由请求层按 off 解析，无需 'default' 占位。
   */
  async function changeReasoningEffort(projectId: string, effort: ReasoningEffort) {
    errorMessage.value = ''

    try {
      const savedConfig = await updateConfig(projectId, {
        llm: { reasoningEffort: effort },
      })
      updateCurrentProjectConfig(savedConfig)
      statusMessage.value = '已切换思考强度档位，下一轮起生效'
      return savedConfig
    } catch (error) {
      errorMessage.value = toMessage(error, '切换思考档位失败')
      return null
    }
  }

  async function runProjectAction<T>(
    action: () => Promise<T>,
    options: { cancelNotice?: string; permissionRetryTarget?: string } = {},
  ) {
    errorMessage.value = ''
    notice.value = null
    isBusy.value = true

    try {
      return await action()
    } catch (error) {
      // 分级反馈（交互优化计划 §5）：用户主动取消与权限待授权不是失败，
      // 不进红色错误区，由视图在原操作附近就地轻提醒。
      if (isAbortError(error)) {
        notice.value = { kind: 'cancelled', message: options.cancelNotice ?? '操作已取消' }
        return null
      }

      if (error instanceof ProjectPermissionRequiredError) {
        notice.value = {
          kind: 'permission',
          message: error.message,
          retryTarget: options.permissionRetryTarget,
        }
        return null
      }

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
    notice,
    recentProjects,
    statusMessage,
    changeActiveOutlinePath,
    changePermissionPreset,
    changeReasoningEffort,
    clearActiveFile,
    closeCurrentProject,
    createNewProject,
    dismissNotice,
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

/** 目录选择器用户取消时浏览器抛出的 AbortError（DOMException 的现代浏览器形态）。 */
function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

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
      // 章节口径：chapters/ 下的 .txt 才算（.md 是待处理的外来文件，不计数）
      return node.path.startsWith('chapters/') && /\.txt$/i.test(node.name)
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
