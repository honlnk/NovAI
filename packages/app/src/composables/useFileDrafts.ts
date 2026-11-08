/**
 * 文件编辑草稿表（交互优化计划 §6「未保存内容保护」+ 数据安全计划 §3-2/§3-3）：
 * 编辑会话按「项目:路径」保留草稿，切换文件/分类/收起面板不静默丢失；回到该文件
 * 时草稿原样恢复。
 *
 * 模块级单例（useConversationFilter 同款）：FilePanelBody 常驻挂载（v-show），
 * 草稿表比组件生命周期长，项目切换靠复合键隔离。
 *
 * 数据安全计划后的增强：
 * - 草稿以「项目、文件身份、内容版本」共同识别：条目记录草稿正文、所依据的磁盘
 *   基线内容、起源路径（重命名迁移前）与最后编辑时间；
 * - 内存表是运行期索引与权威状态，同时镜像到浏览器 IndexedDB（draft-backup，
 *   去抖写入 + 关键时机立即落盘）：刷新/异常退出后重新进入项目可恢复草稿——
 *   恢复只回填内存，绝不自动保存改正文；
 * - 删除/重命名当前文件的草稿去向（§3-3）由 ProjectView 的草稿守护承接，
 *   本模块提供 moveFileDraft（迁移到新路径，保留旧路径关联）；
 * - 正文不自动保存；beforeunload 守卫（真实离开时浏览器确认）继续兜底。
 */

import {
  flushDraftBackup,
  loadProjectDraftBackups,
  removeDraftBackup,
  scheduleDraftBackup,
} from './draft-backup'

export type DraftEntry = {
  /** 用户当前草稿 */
  content: string
  /** 草稿所依据的磁盘内容快照（脏判定基线；恢复后据此提示磁盘是否已变化） */
  baseContent: string
  /** 草稿起源路径（重命名迁移前的旧路径；未迁移时缺省） */
  originPath?: string
  /** 最后编辑时间（ISO） */
  updatedAt?: string
}

const draftsByProject = new Map<string, Map<string, DraftEntry>>()

/** 已恢复（刷新后从 IndexedDB 回填）且尚未被用户知悉的草稿路径 */
const restoredDraftPathsByProject = new Map<string, Set<string>>()

function projectBucket(projectId: string): Map<string, DraftEntry> {
  let bucket = draftsByProject.get(projectId)
  if (!bucket) {
    bucket = new Map()
    draftsByProject.set(projectId, bucket)
  }
  return bucket
}

/** 取某文件的编辑草稿正文；无编辑会话返回 undefined */
export function getFileDraft(projectId: string, path: string): string | undefined {
  return draftsByProject.get(projectId)?.get(path)?.content
}

/** 取某文件的草稿条目（含磁盘基线与起源路径）；无编辑会话返回 undefined */
export function getFileDraftEntry(projectId: string, path: string): DraftEntry | undefined {
  return draftsByProject.get(projectId)?.get(path)
}

/** 记录某文件的编辑草稿（每次编辑实时调用）；草稿与磁盘一致时清除条目 */
export function setFileDraft(projectId: string, path: string, content: string, baseContent: string): void {
  if (content === baseContent) {
    clearFileDraft(projectId, path)
    return
  }
  const previous = getFileDraftEntry(projectId, path)
  projectBucket(projectId).set(path, {
    content,
    baseContent,
    ...(previous?.originPath !== undefined ? { originPath: previous.originPath } : {}),
    updatedAt: new Date().toISOString(),
  })
  scheduleDraftBackup(projectId, path, {
    content,
    baseContent,
    ...(previous?.originPath !== undefined ? { originPath: previous.originPath } : {}),
  })
}

/**
 * 清除草稿（保存成功清除本次保存绑定的草稿、放弃更改、读取最新后调用）；
 * 同步删除持久化备份记录。
 */
export function clearFileDraft(projectId: string, path: string): void {
  draftsByProject.get(projectId)?.delete(path)
  restoredDraftPathsByProject.get(projectId)?.delete(path)
  removeDraftBackup(projectId, path)
}

/**
 * 把草稿迁移到新路径（AI 重命名有人工草稿的文件后用户选择「迁移草稿」）：
 * 保留原路径关联（originPath）与磁盘基线，旧路径条目与备份随之清除。
 */
export function moveFileDraft(projectId: string, fromPath: string, toPath: string): void {
  const bucket = draftsByProject.get(projectId)
  const entry = bucket?.get(fromPath)
  if (!entry) {
    return
  }
  bucket!.delete(fromPath)
  bucket!.set(toPath, {
    ...entry,
    originPath: entry.originPath ?? fromPath,
    updatedAt: new Date().toISOString(),
  })
  restoredDraftPathsByProject.get(projectId)?.delete(fromPath)
  removeDraftBackup(projectId, fromPath)
  scheduleDraftBackup(projectId, toPath, {
    content: entry.content,
    baseContent: entry.baseContent,
    originPath: entry.originPath ?? fromPath,
  })
}

/** 某文件当前是否有未保存草稿 */
export function isFileDraftDirty(projectId: string, path: string): boolean {
  return draftsByProject.get(projectId)?.has(path) ?? false
}

/** 项目内是否存在任何未保存草稿（beforeunload 守卫用） */
export function hasDirtyDrafts(projectId: string): boolean {
  const bucket = draftsByProject.get(projectId)
  return bucket !== undefined && bucket.size > 0
}

/** 项目内全部未保存草稿路径（草稿守护/恢复提示用） */
export function listDirtyDraftPaths(projectId: string): string[] {
  return [...(draftsByProject.get(projectId)?.keys() ?? [])]
}

/** 某文件的草稿是否为「刷新后恢复」且尚未被知悉（面板展示「已恢复未保存草稿」） */
export function isDraftRestoredFromBackup(projectId: string, path: string): boolean {
  return restoredDraftPathsByProject.get(projectId)?.has(path) ?? false
}

/** 用户已知悉恢复提示（打开文件/关闭提示后调用），标记出队 */
export function acknowledgeRestoredDraft(projectId: string, path: string): void {
  restoredDraftPathsByProject.get(projectId)?.delete(path)
}

export type RestoredDraftReport = {
  projectId: string
  /** 本次从持久化恢复的草稿（路径 + 起源路径 + 最后编辑时间），按编辑时间新→旧 */
  restored: Array<{ path: string; originPath?: string; updatedAt: string }>
}

/**
 * 重新进入项目时恢复持久化草稿（数据安全计划 §3-2）：
 * 只回填内存表中尚无草稿的路径（同页会话内存比备份新，不回退）；恢复绝不
 * 触发正文写盘。读取失败抛错，由调用方明确提示并保留当前页面内容。
 */
export async function restorePersistedDrafts(projectId: string): Promise<RestoredDraftReport> {
  const records = await loadProjectDraftBackups(projectId)
  const bucket = projectBucket(projectId)
  const restored: RestoredDraftReport['restored'] = []
  for (const record of records) {
    if (bucket.has(record.path)) {
      continue
    }
    bucket.set(record.path, {
      content: record.content,
      baseContent: record.baseContent,
      ...(record.originPath !== undefined ? { originPath: record.originPath } : {}),
      updatedAt: record.updatedAt,
    })
    restored.push({
      path: record.path,
      ...(record.originPath !== undefined ? { originPath: record.originPath } : {}),
      updatedAt: record.updatedAt,
    })
  }
  restored.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  if (restored.length > 0) {
    const marks = restoredDraftPathsByProject.get(projectId) ?? new Set<string>()
    for (const item of restored) {
      marks.add(item.path)
    }
    restoredDraftPathsByProject.set(projectId, marks)
  }
  return { projectId, restored }
}

/** 立即把待写草稿备份落盘（切换项目/关闭面板等关键时机；ProjectView 调用） */
export function flushDraftBackupsNow(): Promise<void> {
  return flushDraftBackup()
}

/** 测试专用：清空整张草稿表（含恢复标记） */
export function _clearFileDraftsForTest(): void {
  draftsByProject.clear()
  restoredDraftPathsByProject.clear()
}
