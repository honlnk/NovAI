import type { ProjectSnapshot } from '../types/project'

const projectRuntimeMap = new Map<string, ProjectSnapshot>()

export function setRuntimeProject(project: ProjectSnapshot) {
  projectRuntimeMap.set(project.id, project)
}

export function getRuntimeProject(projectId: string) {
  return projectRuntimeMap.get(projectId) ?? null
}

export function requireRuntimeProject(projectId: string) {
  const project = getRuntimeProject(projectId)

  if (!project) {
    throw new Error(`项目未打开或运行时已释放：${projectId}`)
  }

  return project
}

export function hasRuntimeProject(projectId: string) {
  return projectRuntimeMap.has(projectId)
}

export function removeRuntimeProject(projectId: string) {
  projectRuntimeMap.delete(projectId)
}

export function listRuntimeProjects() {
  return Array.from(projectRuntimeMap.values())
}

export function clearRuntimeProjects() {
  projectRuntimeMap.clear()
}
