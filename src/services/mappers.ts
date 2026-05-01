import type { ProjectConfig, ProjectFileContent, ProjectSnapshot, TreeNode } from '../types/project'
import type {
  FileContentView,
  ProjectConfigView,
  ProjectFileNodeView,
  ProjectView,
} from './types'

export function toProjectView(
  project: ProjectSnapshot,
  options?: {
    activeFilePath?: string
  },
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    rootName: project.rootName,
    files: toProjectFileNodeViews(project.tree),
    config: toProjectConfigView(project.config),
    activeFilePath: options?.activeFilePath,
  }
}

export function toProjectConfigView(config: ProjectConfig): ProjectConfigView {
  return {
    version: config.version,
    project: { ...config.project },
    llm: { ...config.llm },
    embedding: { ...config.embedding },
    rerank: { ...config.rerank },
    settings: { ...config.settings },
  }
}

export function toProjectFileNodeViews(nodes: TreeNode[]): ProjectFileNodeView[] {
  return nodes.map((node) => ({
    name: node.name,
    path: node.path,
    kind: node.kind,
    children: node.children ? toProjectFileNodeViews(node.children) : undefined,
  }))
}

export function toFileContentView(file: ProjectFileContent): FileContentView {
  return {
    path: file.path,
    name: file.name,
    format: file.format,
    content: file.content,
    updatedAt: file.updatedAt,
  }
}
