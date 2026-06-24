import {
  readProjectFile,
  rescanProject,
  writeProjectTextFile,
} from '../core/fs/project-fs'

import {
  requireRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import {
  toFileContentView,
  toProjectFileNodeViews,
} from './mappers'
import type {
  FileContentView,
  ProjectFileNodeView,
} from './types'

export async function listFiles(projectId: string): Promise<ProjectFileNodeView[]> {
  const project = requireRuntimeProject(projectId)
  return toProjectFileNodeViews(project.tree)
}

export async function readFile(projectId: string, path: string): Promise<FileContentView> {
  const project = requireRuntimeProject(projectId)
  const file = await readProjectFile(project, path)
  return toFileContentView(file)
}

export async function refreshFiles(projectId: string): Promise<ProjectFileNodeView[]> {
  const project = requireRuntimeProject(projectId)
  const tree = await rescanProject(project)

  setRuntimeProject({
    ...project,
    tree,
  })

  return toProjectFileNodeViews(tree)
}

/**
 * 按相对路径写入项目中的任意文本文件（自动创建中间目录）。
 * 写盘后回读一次，返回含最新 updatedAt 的 FileContentView。
 * 供内容面板编辑模式保存章节 / 提示词 / 要素三类文件使用。
 */
export async function writeFile(
  projectId: string,
  path: string,
  content: string,
): Promise<FileContentView> {
  const project = requireRuntimeProject(projectId)
  await writeProjectTextFile(project.handle, path, content)
  return toFileContentView(await readProjectFile(project, path))
}
