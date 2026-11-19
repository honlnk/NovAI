import {
  readProjectFile,
  rescanProject,
  writeProjectTextFile,
} from '../core/fs/project-fs'
import { hashContent } from '../core/util/hash'

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
 * 保存版本冲突（交互优化计划 §6「未保存内容保护」）：磁盘当前版本与保存所依据的
 * 版本不一致时抛出，磁盘最新 updatedAt 随 error 附带，UI 据此给出保留草稿的选择。
 */
export class FileSaveConflictError extends Error {
  readonly path: string
  /** 冲突类型：modified = 被外部修改；missing = 已被外部删除 */
  readonly kind: 'modified' | 'missing'
  /** 磁盘当前版本（外部修改时） */
  readonly diskUpdatedAt?: string

  constructor(path: string, kind: 'modified' | 'missing', diskUpdatedAt?: string) {
    super(
      kind === 'modified'
        ? `文件 ${path} 已被外部修改（磁盘更新于 ${diskUpdatedAt ?? '未知时间'}），本次保存基于的版本已过期`
        : `文件 ${path} 已被外部删除，无法按当前版本保存`,
    )
    this.name = 'FileSaveConflictError'
    this.path = path
    this.kind = kind
    this.diskUpdatedAt = diskUpdatedAt
  }
}

/**
 * 按相对路径写入项目中的任意文本文件（自动创建中间目录）。
 * 写盘后回读一次，返回含最新 updatedAt 的 FileContentView。
 * 供内容面板编辑模式保存章节 / 提示词 / 要素三类文件使用。
 *
 * 版本校验（§6 + 正文自动保存计划 §四.3 第 9 条）：传入 expectedUpdatedAt（草稿所依据
 * 的磁盘版本）或 expectedBaseHash（编辑基线正文的内容哈希）时，磁盘内容已变或文件
 * 已失则抛 FileSaveConflictError，不覆盖外部修改——磁盘更新时间未能识别变化时由
 * 内容哈希兜底判定（基线正文与磁盘不一致且非幂等写入即冲突）。缺省不做校验
 * （写确认链等调用方有自己的读取状态防线）。内容与磁盘一致时幂等返回，
 * 不重写盘（mtime 不动，避免无意义的新版本）。
 */
export async function writeFile(
  projectId: string,
  path: string,
  content: string,
  options?: { expectedUpdatedAt?: string; expectedBaseHash?: string },
): Promise<FileContentView> {
  const project = requireRuntimeProject(projectId)
  if (options?.expectedUpdatedAt !== undefined || options?.expectedBaseHash !== undefined) {
    const current = await readProjectFile(project, path).catch(() => null)
    if (!current) {
      throw new FileSaveConflictError(path, 'missing')
    }
    if (current.content === content) {
      return toFileContentView(current)
    }
    if (
      options.expectedUpdatedAt !== undefined
      && current.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new FileSaveConflictError(path, 'modified', current.updatedAt)
    }
    if (
      options.expectedBaseHash !== undefined
      && hashContent(current.content) !== options.expectedBaseHash
    ) {
      throw new FileSaveConflictError(path, 'modified', current.updatedAt)
    }
  }
  await writeProjectTextFile(project.handle, path, content)
  return toFileContentView(await readProjectFile(project, path))
}

/**
 * 新建文件语义的写入（数据安全计划 §3-3）：目标已存在时抛 FileExistsError，
 * 绝不覆盖。「恢复为草稿副本」「将草稿另存为副本」走这里——副本保存必须是
 * 用户明确触发的新文件，与 writeFile（可覆盖既有路径）严格区分。
 */
export async function createFile(
  projectId: string,
  path: string,
  content: string,
): Promise<FileContentView> {
  const project = requireRuntimeProject(projectId)
  const existing = await readProjectFile(project, path).catch(() => null)
  if (existing) {
    throw new FileExistsError(path)
  }
  await writeProjectTextFile(project.handle, path, content)
  return toFileContentView(await readProjectFile(project, path))
}

/** createFile 的目标占用错误：调用方提示另选名称，不允许覆盖。 */
export class FileExistsError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`文件 ${path} 已存在，请另选名称`)
    this.name = 'FileExistsError'
    this.path = path
  }
}
