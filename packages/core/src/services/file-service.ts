import {
  readProjectFile,
  rescanProject,
  writeChapterFile,
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

export async function writeChapter(
  projectId: string,
  fileName: string,
  markdown: string,
): Promise<FileContentView> {
  const project = requireRuntimeProject(projectId)
  const savedName = await writeChapterFile(project.handle, fileName, markdown)
  return toFileContentView(await readProjectFile(project, `chapters/${savedName}`))
}
