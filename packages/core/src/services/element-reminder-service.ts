import { readProjectConfig } from '../core/fs/project-fs'

import { requireRuntimeProject } from './project-runtime'
import { updateConfig } from './settings-service'

/**
 * 要素整理提醒（入口重构 W3）：距上次整理新增 ≥ 2 章时，输入框上方滑入提醒按钮。
 *
 * 阈值判定与模板填充均为纯函数（可测）；IO 薄层遍历 chapters/ 与 elements/ 取
 * 文件 mtime（FileSystemFileHandle.getFile().lastModified），elements 最新 mtime
 * 作为「上次整理时间」的代理——整理必写要素文件，mtime 随之前移，新增计数自然归零。
 */

/** 提醒模板默认值（决策 6）；{章节名列表} 占位符由代码填充为真实章节名 */
export const DEFAULT_ELEMENT_REMINDER_TEMPLATE = '/管理要素 对新增章节：{章节名列表}，提取要素，要求：'

/** 模板中章节名列表的占位符 */
export const ELEMENT_REMINDER_CHAPTER_LIST_PLACEHOLDER = '{章节名列表}'

/** 距上次整理新增章节达到该数即提醒（决策 7 默认阈值） */
export const ELEMENT_REMINDER_NEW_CHAPTER_THRESHOLD = 2

/** 阈值判定纯函数的章节输入：文件名（去扩展）+ mtime（ms） */
export type ChapterStat = {
  name: string
  lastModified: number
}

export type ElementReminderEvaluation = {
  /** 是否到达提醒条件 */
  due: boolean
  /** 晚于上次整理的全部章节名（按名排序），供模板填充与提示展示 */
  newChapters: string[]
}

/**
 * 阈值判定（纯函数）：
 * - 新增章节 = mtime 晚于 elements 最新 mtime（上次整理时间代理）的章节；从未整理（null）时全部算新增；
 * - 到期 = 新增数 ≥ threshold，且其中至少一章晚于 lastRemindedAt（上次提醒之后有新动作）——
 *   同一批新增只提醒一次；用户点掉提醒后继续写新章，状态变化会再次到期。
 */
export function evaluateElementReminder(
  chapters: ChapterStat[],
  elementsLatestModified: number | null,
  lastRemindedAt?: number,
  threshold: number = ELEMENT_REMINDER_NEW_CHAPTER_THRESHOLD,
): ElementReminderEvaluation {
  const baseline = elementsLatestModified ?? 0
  const isNew = (chapter: ChapterStat): boolean => chapter.lastModified > baseline
  const newChapters = chapters
    .filter(isNew)
    .map((chapter) => chapter.name)
    .sort()
  const hasActivitySinceLastReminder = chapters.some(
    (chapter) => isNew(chapter) && chapter.lastModified > (lastRemindedAt ?? 0),
  )
  return {
    due: newChapters.length >= threshold && hasActivitySinceLastReminder,
    newChapters,
  }
}

/** 模板填充（纯函数）：{章节名列表} 替换为真实章节名（顿号分隔）；模板无占位符时原样返回。 */
export function fillElementReminderTemplate(template: string, chapterNames: string[]): string {
  return template
    .split(ELEMENT_REMINDER_CHAPTER_LIST_PLACEHOLDER)
    .join(chapterNames.join('、'))
}

/** 整理提醒检查结果（checkElementReminder 返回） */
export type ElementReminderCheck = {
  due: boolean
  newChapters: string[]
  /** 已填充章节名的完整草稿文案：点击提醒时直接落输入框光标处 */
  draft: string
}

/** 检查整理提醒（IO）：读配置模板 + 遍历两目录取 mtime，判定并填充模板。 */
export async function checkElementReminder(projectId: string): Promise<ElementReminderCheck> {
  const project = requireRuntimeProject(projectId)
  const config = await readProjectConfig(project.handle)
  const [chapters, elementsLatestModified] = await Promise.all([
    collectChapterStats(project.handle),
    collectElementsLatestModified(project.handle),
  ])
  const template = config.elementReminder?.template?.trim() || DEFAULT_ELEMENT_REMINDER_TEMPLATE
  const evaluation = evaluateElementReminder(
    chapters,
    elementsLatestModified,
    config.elementReminder?.lastRemindedAt,
  )
  return {
    due: evaluation.due,
    newChapters: evaluation.newChapters,
    draft: fillElementReminderTemplate(template, evaluation.newChapters),
  }
}

/** 提醒已展示（采用或忽略均调用）：写 lastRemindedAt 抑制同一批新增的重复提醒。 */
export async function markElementReminderShown(projectId: string): Promise<void> {
  await updateConfig(projectId, { elementReminder: { lastRemindedAt: Date.now() } })
}

/** chapters/*.txt 的名 + mtime 清单（.md 大纲等非章节文件不入列） */
async function collectChapterStats(rootHandle: FileSystemDirectoryHandle): Promise<ChapterStat[]> {
  const chaptersDir = await getDirectoryOrNull(rootHandle, 'chapters')
  if (!chaptersDir) {
    return []
  }
  const stats: ChapterStat[] = []
  for await (const entry of chaptersDir.values()) {
    if (entry.kind !== 'file' || !/\.txt$/i.test(entry.name)) {
      continue
    }
    stats.push({
      name: entry.name.replace(/\.txt$/i, ''),
      lastModified: (await (entry as FileSystemFileHandle).getFile()).lastModified,
    })
  }
  return stats
}

/** elements/ 全部文件（递归子目录）的最新 mtime；目录不存在或为空返回 null（视为从未整理）。 */
async function collectElementsLatestModified(rootHandle: FileSystemDirectoryHandle): Promise<number | null> {
  const elementsDir = await getDirectoryOrNull(rootHandle, 'elements')
  if (!elementsDir) {
    return null
  }
  let latest: number | null = null
  const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        const mtime = (await (entry as FileSystemFileHandle).getFile()).lastModified
        if (latest === null || mtime > latest) {
          latest = mtime
        }
      } else {
        await walk(entry as FileSystemDirectoryHandle)
      }
    }
  }
  await walk(elementsDir)
  return latest
}

async function getDirectoryOrNull(
  rootHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await rootHandle.getDirectoryHandle(name)
  } catch {
    return null
  }
}
