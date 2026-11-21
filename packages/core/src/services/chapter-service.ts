/**
 * 章节查询与真实新建领域服务（作者字段控制权计划阶段 1）。
 *
 * 面向卡片章节选择器：封装章节列表、章号解析、命名规范、章号唯一性校验和
 * 空章节创建；复用现有项目与文件能力（运行时快照 + file-service 新建语义），
 * 界面不直接读写项目文件。纯函数部分在 core/chapters/，这里再导出供 app 经
 * `@novai/core/services/chapter-service` 合法子路径取用。
 */
import { rescanProject } from '../core/fs/project-fs'
import {
  buildChapterCatalog,
  chapterNumberPadWidth,
} from '../core/chapters/catalog'
import {
  buildChapterFileName,
  resolveCreateTargetDirectory,
} from '../core/chapters/create'
import { createFile } from './file-service'
import { requireRuntimeProject, setRuntimeProject } from './project-runtime'
import {
  ChapterNumberTakenError,
  InvalidChapterNumberError,
} from '../types/chapters'
import type {
  ChapterCatalog,
  CreateChapterInput,
  CreateChapterResult,
} from '../types/chapters'

export {
  buildChapterCatalog,
  resolveChapterReference,
  filterChapterEntries,
  suggestNextChapterNumber,
  chapterNumberPadWidth,
} from '../core/chapters/catalog'
export type { ChapterTreeSourceNode } from '../core/chapters/catalog'
export { buildChapterFileName, resolveCreateTargetDirectory, DEFAULT_CHAPTER_TITLE } from '../core/chapters/create'
export {
  ChapterNumberTakenError,
  InvalidChapterNumberError,
} from '../types/chapters'
export type {
  ChapterCatalog,
  ChapterCatalogEntry,
  ChapterRefResolution,
  CreateChapterInput,
  CreateChapterResult,
} from '../types/chapters'

/** 读取章节目录（基于运行时快照树，无额外 IO）。 */
export async function listProjectChapters(projectId: string): Promise<ChapterCatalog> {
  const project = requireRuntimeProject(projectId)
  return buildChapterCatalog(project.tree)
}

/**
 * 真实新建空章节（选择器「创建并选择」的落盘侧）：
 * - 章号必须为正整数；被占用时抛 ChapterNumberTakenError（携带占用条目）；
 * - 标题留空按「未命名」生成规范文件名；落点跟随最新章所在目录；
 * - 新建语义：目标已存在绝不覆盖（file-service.createFile 兜底）；
 * - 只创建文件不写正文——章节正文由作者在章节编辑区另行撰写；
 * - 成功后重扫并更新运行时树，返回新条目。
 */
export async function createProjectChapter(
  projectId: string,
  input: CreateChapterInput,
): Promise<CreateChapterResult> {
  const project = requireRuntimeProject(projectId)

  if (!Number.isInteger(input.chapterNumber) || input.chapterNumber < 1) {
    throw new InvalidChapterNumberError(input.chapterNumber)
  }

  // 全树扫描真实磁盘判定占用与落点，不吃运行时树的陈旧状态
  const tree = await rescanProject(project)
  const catalog = buildChapterCatalog(tree)

  const existing = catalog.entries.filter(entry => entry.number === input.chapterNumber)
  if (existing.length > 0) {
    throw new ChapterNumberTakenError(existing)
  }

  const directory = resolveCreateTargetDirectory(catalog)
  const fileName = buildChapterFileName(input.chapterNumber, input.title, chapterNumberPadWidth(catalog))
  const path = directory ? `chapters/${directory}/${fileName}` : `chapters/${fileName}`

  await createFile(projectId, path, '')

  const nextTree = await rescanProject(project)
  setRuntimeProject({ ...project, tree: nextTree })

  const entry = buildChapterCatalog(nextTree)
    .entries.find(candidate => candidate.number === input.chapterNumber && candidate.path === path)
  if (!entry) {
    throw new Error(`章节已创建但未能在目录中定位：${path}`)
  }

  return { entry }
}
