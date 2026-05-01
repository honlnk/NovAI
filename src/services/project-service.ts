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
  hasProjectPermission,
  readLastProject,
  requestProjectPermission,
  saveLastProject,
  toLastProjectSummary,
} from '../core/project/recent-projects'
import type { ProjectSnapshot } from '../types/project'

import {
  getRuntimeProject,
  removeRuntimeProject,
  requireRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
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
  // it loads valid projects and gently fills missing optional defaults.
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

  const project = await loadProjectFromHandle(record.handle)
  await activateProject(project, 'project_restored', `恢复上次项目「${project.name}」`, {
    rememberedAt: record.lastOpenedAt,
  })

  return toProjectView(project, {
    activeFilePath: findFirstReadableFile(project.tree) ?? undefined,
  })
}

export async function getLastProjectSummary(): Promise<LastProjectSummaryView | null> {
  const record = await readLastProject()
  return record ? toLastProjectSummary(record) : null
}

export async function forgetLastProject(): Promise<void> {
  await forgetStoredLastProject()
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

function asRecord(value: unknown) {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}
