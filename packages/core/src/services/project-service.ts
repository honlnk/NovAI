import {
  createProject as createCoreProject,
  findFirstReadableFile,
  inspectProject as inspectCoreProject,
  isFileSystemAccessSupported,
  loadProjectFromHandle,
  pickProjectDirectory,
  repairProject,
  rescanProject,
} from '../core/fs/project-fs'
import { writeAgentLog } from '../core/logging/agent-log'
import {
  forgetLastProject as forgetStoredLastProject,
  forgetRecentProject as forgetStoredRecentProject,
  hasProjectPermission,
  readLastProject,
  readRecentProject,
  readRecentProjects,
  requestProjectPermission,
  saveLastProject,
  toLastProjectSummary,
  updateRecentProjectCounts,
} from '../core/project/recent-projects'
import type { ProjectSnapshot } from '../types/project'

import {
  getRuntimeProject,
  removeRuntimeProject,
  requireRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import { evictProjectSessions } from './agent-service'
import { toProjectView } from './mappers'
import type { LastProjectSummaryView, ProjectStatusView, ProjectView } from './types'

export function isProjectAccessSupported(): boolean {
  return isFileSystemAccessSupported()
}

export async function createProject(name: string): Promise<ProjectView> {
  assertFileSystemAccessSupported()

  const project = await createCoreProject(name)
  await activateProject(project, 'project_created', `创建项目「${project.name}」`)
  return toProjectView(project, {
    activeFilePath: findFirstReadableFile(project.tree) ?? undefined,
  })
}

export async function openProject(): Promise<ProjectView> {
  assertFileSystemAccessSupported()

  const handle = await pickProjectDirectory()
  const inspection = await inspectCoreProject(handle)
  // repairProject is intentionally used for both valid and incomplete projects:
  // it loads valid projects and gently fills the structure required for loading.
  const project = await repairProject(handle)

  await activateProject(project, 'project_opened', `打开项目「${project.name}」`, {
    inspectionIssues: inspection.issues,
  })

  return toProjectView(project, {
    activeFilePath: findFirstReadableFile(project.tree) ?? undefined,
  })
}

export async function restoreLastProject(): Promise<ProjectView | null> {
  assertFileSystemAccessSupported()

  const record = await readLastProject()

  if (!record) {
    return null
  }

  const hasPermission = await hasProjectPermission(record.handle)
    || await requestProjectPermission(record.handle)

  if (!hasPermission) {
    return null
  }

  const project = await repairProject(record.handle)
  await activateProject(project, 'project_restored', `恢复上次项目「${project.name}」`, {
    rememberedAt: record.lastOpenedAt,
  })

  return toProjectView(project, {
    activeFilePath: findFirstReadableFile(project.tree) ?? undefined,
  })
}

export async function restoreRecentProject(projectId: string): Promise<ProjectView | null> {
  assertFileSystemAccessSupported()

  const record = await readRecentProject(projectId)

  if (!record) {
    return null
  }

  const hasPermission = await hasProjectPermission(record.handle)
    || await requestProjectPermission(record.handle)

  if (!hasPermission) {
    return null
  }

  const project = await repairProject(record.handle)
  await activateProject(project, 'project_restored_from_recent', `恢复最近项目「${project.name}」`, {
    rememberedAt: record.lastOpenedAt,
    requestedProjectId: projectId,
  })

  return toProjectView(project, {
    activeFilePath: findFirstReadableFile(project.tree) ?? undefined,
  })
}

export async function getLastProjectSummary(): Promise<LastProjectSummaryView | null> {
  const record = await readLastProject()
  return record ? toLastProjectSummary(record) : null
}

export async function getRecentProjects(): Promise<LastProjectSummaryView[]> {
  return readRecentProjects()
}

/**
 * 首屏静默刷新最近项目的章节数与要素数。
 *
 * 解决「必须打开一遍才显示计数」的体验问题：对每个最近项目，若目录句柄仍持有
 * 读写权限（只查询、不弹权限框），就重新扫描目录算出计数并回写；没有权限或扫描
 * 失败的项目原样保留旧值。整个过程不阻塞首屏（调用方应异步触发，不 await），
 * 且不会修改 lastOpenedAt，避免破坏列表的时间排序。
 *
 * @returns 刷新完成后的最新最近项目列表
 */
export async function refreshRecentProjectCounts(): Promise<LastProjectSummaryView[]> {
  const summaries = await readRecentProjects()

  await Promise.all(
    summaries.map(async (summary) => {
      try {
        const record = await readRecentProject(summary.projectId)
        // 没有记录，或目录权限尚未授予（不主动请求），跳过保留旧值。
        if (!record || !(await hasProjectPermission(record.handle))) {
          return
        }

        const project = await loadProjectFromHandle(record.handle)
        await updateRecentProjectCounts(
          project.id,
          project.metadata.chapterCount,
          project.metadata.elementCount,
        )
      } catch {
        // 单个项目刷新失败不影响其它项目。
      }
    }),
  )

  return readRecentProjects()
}

export async function forgetLastProject(): Promise<void> {
  await forgetStoredLastProject()
}

export async function forgetRecentProject(projectId: string): Promise<void> {
  await forgetStoredRecentProject(projectId)
}

export async function deleteRecentProject(
  projectId: string,
  options: {
    deleteDirectory?: boolean
  } = {},
): Promise<void> {
  const record = await readRecentProject(projectId)

  if (!record) {
    await forgetStoredRecentProject(projectId)
    return
  }

  if (options.deleteDirectory) {
    assertFileSystemAccessSupported()

    const hasPermission = await hasProjectPermission(record.handle)
      || await requestProjectPermission(record.handle)

    if (!hasPermission) {
      throw new Error('没有获得项目目录读写权限，已取消删除本地目录。')
    }

    await removeProjectDirectory(record.handle)
  }

  await forgetStoredRecentProject(projectId)

  const lastRecord = await readLastProject()
  if (lastRecord?.projectId === projectId) {
    await forgetStoredLastProject()
  }

  removeRuntimeProject(projectId)
  // 同步释放该项目驻留的会话缓存，避免历史会话累积内存泄漏
  evictProjectSessions(projectId)
}

export async function closeProject(projectId: string): Promise<void> {
  const project = getRuntimeProject(projectId)

  if (!project) {
    return
  }

  await writeAgentLog(project, {
    level: 'info',
    event: 'project_closed',
    message: `关闭项目「${project.name}」`,
    data: {
      rootName: project.rootName,
    },
  })

  removeRuntimeProject(projectId)
  // 关闭即释放该项目驻留的会话缓存，避免历史会话累积内存泄漏
  evictProjectSessions(projectId)
}

export async function refreshProject(projectId: string): Promise<ProjectView> {
  const project = requireRuntimeProject(projectId)
  const tree = await rescanProject(project)
  const nextProject: ProjectSnapshot = {
    ...project,
    tree,
  }

  setRuntimeProject(nextProject)

  return toProjectView(nextProject, {
    activeFilePath: findFirstReadableFile(tree) ?? undefined,
  })
}

export async function inspectProject(projectId: string): Promise<ProjectStatusView> {
  const project = requireRuntimeProject(projectId)
  const inspection = await inspectCoreProject(project.handle)

  return {
    projectId,
    rootName: inspection.rootName,
    canLoad: inspection.canLoad,
    issues: inspection.issues,
  }
}

async function activateProject(
  project: ProjectSnapshot,
  event: string,
  message: string,
  data?: unknown,
) {
  setRuntimeProject(project)

  await saveLastProject({
    projectId: project.id,
    name: project.name,
    rootName: project.rootName,
    handle: project.handle,
    chapterCount: project.metadata.chapterCount,
    elementCount: project.metadata.elementCount,
  })

  await writeAgentLog(project, {
    level: 'info',
    event,
    message,
    data: {
      rootName: project.rootName,
      ...asRecord(data),
    },
  })
}

function assertFileSystemAccessSupported() {
  if (!isFileSystemAccessSupported()) {
    throw new Error('当前浏览器不支持 File System Access API，请使用 Chromium 内核浏览器。')
  }
}

async function removeProjectDirectory(handle: FileSystemDirectoryHandle) {
  const removableHandle = handle as FileSystemDirectoryHandle & {
    remove?: (options?: { recursive?: boolean }) => Promise<void>
  }

  if (!removableHandle.remove) {
    throw new Error('当前浏览器不支持直接删除已记住的项目目录，请在系统文件管理器中手动删除。')
  }

  await removableHandle.remove({ recursive: true })
}

function asRecord(value: unknown) {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}
