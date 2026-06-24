import { listFilesInDirectory, moveProjectTextFile, readProjectTextFile } from '../core/fs/project-fs'
import { requireRuntimeProject } from './project-runtime'
import {
  CHAPTER_NAME_PATTERN,
  formatChapterName,
  isChapterNameCompliant,
  parseChapterNumber,
  suggestChapterTitle,
} from '../core/tools/chapter-name'

/**
 * 章节整理工具。
 *
 * 解决命名规范落地后旧项目的不规范章节文件：
 * - 章节格式已统一为 `第NNN章-标题.txt`，工具层会拒绝新建/编辑不合规的章节。
 * - 旧项目里残留的 `.md` 章节、不补零的编号、无标题的文件会被锁死（无法 EditFile）。
 * - 本 service 扫描 chapters/ 目录，给出规范化建议名，经用户确认后批量改名。
 *
 * 缺标题的文件用正文首行兜底生成建议标题（needsReview 标记，让用户在 UI 里确认/修改）。
 */

/** 整理原因 */
export type ChapterOrganizeReason = 'format' | 'extension'

/** 单个章节的整理建议 */
export type ChapterOrganizeItem = {
  /** 当前路径，如 chapters/legacy.md */
  currentPath: string
  /** 当前文件名（basename） */
  currentName: string
  /** 建议的新路径，如 chapters/第001章-火中拾婴.txt */
  suggestedPath: string
  /** 建议的新文件名（basename） */
  suggestedName: string
  /** 整理原因：format=命名格式不规范，extension=扩展名需改为 .txt */
  reason: ChapterOrganizeReason
  /**
   * 是否需要用户确认。
   * 缺标题、靠正文首行兜底的项标记 true，UI 里高亮可编辑。
   */
  needsReview: boolean
}

/** 整理扫描结果 */
export type ChapterOrganizePlan = {
  items: ChapterOrganizeItem[]
  /** 已符合规范、无需整理的章节数 */
  compliantCount: number
}

/** 单个文件改名结果 */
export type ChapterOrganizeResult = {
  fromPath: string
  toPath: string
  ok: boolean
  error?: string
}

/**
 * 扫描 chapters/ 目录，生成整理计划。
 * 已规范的文件跳过（计入 compliantCount），不规范的文件给出建议名。
 *
 * 编号分配策略：
 * - 文件名能解析出「第N章」编号的，沿用原编号补零。
 * - 解析不出编号的（如 legacy.md、chapter-001-xx.txt 无中文编号），
 *   按当前文件名排序顺序，分配 max(已用编号)+1 起的连续编号。
 */
export async function scanChaptersForOrganize(projectId: string): Promise<ChapterOrganizePlan> {
  const project = requireRuntimeProject(projectId)
  const paths = await listFilesInDirectory(project.handle, 'chapters')

  // 收集已占用编号（来自规范文件），用于给无编号文件分配新编号
  const usedNumbers = new Set<number>()
  for (const path of paths) {
    const num = parseChapterNumber(path)
    if (num !== null && isChapterNameCompliant(path.slice('chapters/'.length))) {
      usedNumbers.add(num)
    }
  }

  // 排序保证无编号文件的分配顺序稳定（与文件树 localeCompare 一致）
  const sortedPaths = [...paths].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  let nextAssignedNumber = 1
  while (usedNumbers.has(nextAssignedNumber)) {
    nextAssignedNumber += 1
  }

  const items: ChapterOrganizeItem[] = []
  let compliantCount = 0

  for (const path of sortedPaths) {
    const name = path.slice('chapters/'.length)

    if (isChapterNameCompliant(name)) {
      compliantCount += 1
      continue
    }

    const item = await buildOrganizeItem(project.handle, path, name, usedNumbers, () => {
      const assigned = nextAssignedNumber
      nextAssignedNumber += 1
      return assigned
    })

    if (item) {
      items.push(item)
    }
  }

  return { items, compliantCount }
}

/**
 * 为单个不规范章节构建整理建议。
 * 返回 null 表示无法处理（理论上不会发生，所有非规范文件都会给建议）。
 */
async function buildOrganizeItem(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
  name: string,
  usedNumbers: Set<number>,
  assignNumber: () => number,
): Promise<ChapterOrganizeItem | null> {
  const reason: ChapterOrganizeReason = name.toLowerCase().endsWith('.md') ? 'extension' : 'format'

  // 1. 确定编号：优先沿用文件名里能解析出的编号，否则分配新编号
  const parsedNumber = parseChapterNumber(name)
  let number: number
  if (parsedNumber !== null) {
    number = parsedNumber
  } else {
    number = assignNumber()
  }

  // 2. 确定标题：
  //    - 文件名里若带「第N章-标题」格式但整体不合规（如补零不足），提取原标题
  //    - 否则读正文首行兜底，标记 needsReview
  const titleMatch = /^第\d+章-(.+)\.(?:txt|md)$/i.exec(name)
  let title: string
  let needsReview: boolean

  if (titleMatch && titleMatch[1].trim()) {
    title = titleMatch[1].trim()
    needsReview = false
  } else {
    // 读正文兜底
    let content = ''
    try {
      content = await readProjectTextFile(rootHandle, path)
    } catch {
      content = ''
    }
    title = suggestChapterTitle(content)
    needsReview = true
  }

  const suggestedName = formatChapterName(number, title)
  const suggestedPath = `chapters/${suggestedName}`

  // 建议名与当前名相同（理论不会，因为当前名不合规）则跳过
  if (suggestedPath === path) {
    return null
  }

  return {
    currentPath: path,
    currentName: name,
    suggestedPath,
    suggestedName,
    reason,
    needsReview,
  }
}

/**
 * 执行整理计划：批量把每个 item 从 currentPath 改名到 suggestedPath。
 * 某个文件失败不影响其他文件，结果逐项返回。
 *
 * 注意：调用方应在用户确认计划后调用，且建议先扫描再执行（避免并发改名冲突）。
 */
export async function applyChapterOrganize(
  projectId: string,
  items: Array<Pick<ChapterOrganizeItem, 'currentPath' | 'suggestedPath'>>,
): Promise<ChapterOrganizeResult[]> {
  const project = requireRuntimeProject(projectId)
  const results: ChapterOrganizeResult[] = []

  for (const item of items) {
    try {
      await moveProjectTextFile(project.handle, item.currentPath, item.suggestedPath)
      results.push({ fromPath: item.currentPath, toPath: item.suggestedPath, ok: true })
    } catch (error) {
      results.push({
        fromPath: item.currentPath,
        toPath: item.suggestedPath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

export { CHAPTER_NAME_PATTERN }
