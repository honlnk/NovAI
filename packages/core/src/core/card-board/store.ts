import {
  readProjectTextFile,
  removeProjectFile,
  writeProjectTextFile,
} from '../fs/project-fs'
import { createTrashPath } from '../fs/trash'
import type { CardProjectSnapshot } from './catalog'

/**
 * 看板卡片落盘原语（计划/伏笔/节奏卡共用）：按稳定标识定位、存在性探测、
 * 「写新删旧」重命名（带回滚）、移入回收站。错误类型由调用方注入（领域错误消息）。
 */

/** 按稳定标识在扫描结果中定位卡片并读取文件原文；找不到或读不出返回 null。 */
export async function locateCardContent(
  project: CardProjectSnapshot,
  cards: readonly { id: string; sourcePath: string }[],
  id: string,
): Promise<{ path: string; content: string } | null> {
  for (const card of cards) {
    if (card.id !== id) {
      continue
    }

    try {
      return { path: card.sourcePath, content: await readProjectTextFile(project.handle, card.sourcePath) }
    } catch {
      return null
    }
  }

  return null
}

/** 探测卡片文件是否可读（存在性检查，重命名目标占用探测用）。 */
export async function cardFileExists(project: CardProjectSnapshot, path: string): Promise<boolean> {
  try {
    await readProjectTextFile(project.handle, path)
    return true
  } catch {
    return false
  }
}

/**
 * 卡片落盘。nextPath 与 currentPath 不同时执行「写完整新文件 → 删旧文件」重命名
 * （浏览器 FSA 无原子重命名原语）；删旧失败时清理刚写入的新文件再报错，避免同 ID 双卡。
 * 目标路径被其他卡片或未知文件占用时报错（不覆盖任何已有文件）。
 * 领域错误消息（占用/回滚）由调用方注入，保持各领域现有文案。
 */
export async function writeCardFile(
  project: CardProjectSnapshot,
  options: {
    /** 现路径；null = 新建。 */
    currentPath: string | null
    nextPath: string
    content: string
    /** 扫描到的全部卡片路径（目标占用检查；与 currentPath 相同不算占用）。 */
    existingPaths: readonly string[]
    /** 领域错误工厂：占用与回滚两类消息。 */
    errors: {
      occupied(nextPath: string): Error
      renameFailed(currentPath: string, nextPath: string, reason: string): Error
    }
  },
): Promise<void> {
  const { currentPath, nextPath, content, existingPaths, errors } = options

  if (currentPath === null || nextPath === currentPath) {
    await writeProjectTextFile(project.handle, nextPath, content)
    return
  }

  // 目标占用检查（同路径 no-op 已排除）：改名不得覆盖任何已有文件
  const occupied = existingPaths.some((path) => path === nextPath && path !== currentPath)
    || await cardFileExists(project, nextPath)

  if (occupied) {
    throw errors.occupied(nextPath)
  }

  await writeProjectTextFile(project.handle, nextPath, content)

  try {
    await removeProjectFile(project.handle, currentPath)
  } catch (error) {
    await removeProjectFile(project.handle, nextPath).catch(() => {})
    const reason = error instanceof Error ? `：${error.message}` : ''
    throw errors.renameFailed(currentPath, nextPath, reason)
  }
}

/** 卡片移入回收站：写 .novel/trash/ 副本后删原文件（与 DeleteFile 同语义）。 */
export async function trashCardFile(
  project: CardProjectSnapshot,
  path: string,
  content: string,
): Promise<string> {
  const trashPath = createTrashPath(path)
  await writeProjectTextFile(project.handle, trashPath, content)
  await removeProjectFile(project.handle, path)
  return trashPath
}

/** 下一个创建时序号：现有文件序号最大值 + 1（从 1 开始；删除后允许不连续）。 */
export function nextCardSequence(paths: readonly string[], extractSequence: (path: string) => number | null): number {
  const max = paths.reduce((current, path) => {
    const sequence = extractSequence(path)
    return sequence === null ? current : Math.max(current, sequence)
  }, 0)

  return max + 1
}
