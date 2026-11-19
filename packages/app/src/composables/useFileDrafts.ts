/**
 * 文件编辑草稿表 —— 编辑器会话状态机的兼容访问层（正文自动保存与并发冲突
 * 交互重设计计划 §四.1/§六.1）：
 *
 * 内存「草稿表」不再是被单独维护的概念，而是编辑器会话（editor-session）的
 * 未落盘编辑数据视图：条目 = 会话的 content / baseContent / originPath，
 * 脏判定 = 最新输入与编辑基线不一致。IndexedDB 备份（draft-backup）是会话的
 * **未落盘恢复镜像**——权威正文仍是项目磁盘，内存会话保存运行期最新输入。
 *
 * 保存编排（快照、串行、冲突、守护）在 editor-session 中统一处理；本模块
 * 只保留原草稿表 API 形态供 ProjectView / WriteConfirmPanel / save-outcome
 * 等既有调用方使用（阶段 4 确认链改接统一保存会话后进一步收敛）。
 */

import {
  loadProjectDraftBackups,
  flushDraftBackup,
} from './draft-backup'
import {
  acknowledgeRestoredEditor,
  clearEditorSession,
  editorSessionNeedsLeaveGuard,
  getEditorSession,
  isEditorSessionDirty,
  listEditorSessions,
  migrateEditorSession,
  restoreEditorSessions,
  type RestoredEditorReport,
  upsertEditorSessionData,
  _resetEditorSessionsForTest,
} from './editor-session'

export type DraftEntry = {
  /** 用户当前草稿 */
  content: string
  /** 草稿所依据的磁盘内容快照（脏判定基线；恢复后据此提示磁盘是否变化） */
  baseContent: string
  /** 草稿起源路径（重命名迁移前的旧路径；未迁移时缺省） */
  originPath?: string
  /** 最后编辑时间（ISO） */
  updatedAt?: string
}

function toEntry(
  projectId: string,
  path: string,
): DraftEntry | undefined {
  const session = getEditorSession(projectId, path)
  if (!session || !isEditorSessionDirty(session)) {
    return undefined
  }
  return {
    content: session.content,
    baseContent: session.baseContent,
    ...(session.originPath !== undefined ? { originPath: session.originPath } : {}),
    updatedAt: session.updatedAt,
  }
}

/** 取某文件的编辑草稿正文；无编辑会话（或与基线一致）返回 undefined */
export function getFileDraft(projectId: string, path: string): string | undefined {
  return toEntry(projectId, path)?.content
}

/** 取某文件的草稿条目（含磁盘基线与起源路径）；无编辑会话返回 undefined */
export function getFileDraftEntry(projectId: string, path: string): DraftEntry | undefined {
  return toEntry(projectId, path)
}

/**
 * 记录/重定某文件的草稿数据（rebase、恢复、迁移后的兼容路径）：
 * 不触发保存编排（面板输入走 editor-session 的 setEditorInput）。
 * 草稿与基线一致时清除条目（与原草稿表语义一致：不残留假脏条目）。
 */
export function setFileDraft(projectId: string, path: string, content: string, baseContent: string): void {
  if (content === baseContent) {
    clearFileDraft(projectId, path)
    return
  }
  const previous = getEditorSession(projectId, path)
  upsertEditorSessionData(projectId, path, {
    content,
    baseContent,
    ...(previous?.originPath !== undefined ? { originPath: previous.originPath } : {}),
  })
}

/**
 * 清除草稿（放弃更改、采用磁盘版本后调用）；同步删除持久化备份记录。
 */
export function clearFileDraft(projectId: string, path: string): void {
  clearEditorSession(projectId, path)
}

/**
 * 把草稿迁移到新路径（AI 重命名有人工草稿的文件后用户选择「迁移草稿」）：
 * 保留原路径关联（originPath）与磁盘基线，旧路径条目与备份随之清除。
 */
export function moveFileDraft(projectId: string, fromPath: string, toPath: string): void {
  migrateEditorSession(projectId, fromPath, toPath)
}

/** 某文件当前是否有未保存草稿 */
export function isFileDraftDirty(projectId: string, path: string): boolean {
  const session = getEditorSession(projectId, path)
  return session !== undefined && isEditorSessionDirty(session)
}

/**
 * 项目内是否存在需要离开提醒的内容（§六.3）：有待写、在途、失败、冲突、
 * 恢复未校验或守护未处理内容时提醒继续存在；正常保存完成后不因短暂编辑历史提醒。
 */
export function hasDirtyDrafts(projectId: string): boolean {
  return listDirtyDraftPaths(projectId).length > 0
}

/** 项目内全部未保存草稿路径（草稿守护/恢复提示用） */
export function listDirtyDraftPaths(projectId: string): string[] {
  // 有待写内容，或在途/失败/冲突/恢复未校验/守护未处理的会话都保留提醒与再入口
  return listEditorSessions(projectId)
    .filter((session) => isEditorSessionDirty(session) || editorSessionNeedsLeaveGuard(session))
    .map((session) => session.path)
}

/** 某文件的草稿是否为「刷新后恢复」且尚未被知悉（面板展示「已恢复上次未写完的内容」） */
export function isDraftRestoredFromBackup(projectId: string, path: string): boolean {
  const session = getEditorSession(projectId, path)
  return session !== undefined && session.restoredPending && !session.restoredAcked
}

/** 用户已知悉恢复提示（打开文件/关闭提示后调用），标记出队 */
export function acknowledgeRestoredDraft(projectId: string, path: string): void {
  acknowledgeRestoredEditor(projectId, path)
}

export type RestoredDraftReport = RestoredEditorReport

/**
 * 重新进入项目时恢复持久化草稿（§六.2 存量恢复迁移）：
 * 只回填内存中尚无有效会话的路径（同页会话内存比备份新，不回退）；回填绝不
 * 触发正文写盘（续存内容由自动保存随后落盘）。恢复时逐文件核对磁盘：内容与
 * 磁盘一致清冗余记录；基线一致自动续存；磁盘已变建立版本冲突；原路径已删除
 * 进入删除守护（判定见 editor-session.restoreEditorSessions）。
 * 读取失败抛错，由调用方明确提示并保留当前页面内容。
 */
export async function restorePersistedDrafts(projectId: string): Promise<RestoredDraftReport> {
  const records = await loadProjectDraftBackups(projectId)
  return restoreEditorSessions(
    projectId,
    records.map((record) => ({
      path: record.path,
      content: record.content,
      baseContent: record.baseContent,
      ...(record.originPath !== undefined ? { originPath: record.originPath } : {}),
      updatedAt: record.updatedAt,
    })),
  )
}

/** 立即把待写草稿备份落盘（切换项目/关闭面板等关键时机；ProjectView 调用） */
export function flushDraftBackupsNow(): Promise<void> {
  return flushDraftBackup()
}

/** 测试专用：清空整张草稿表（含恢复标记与底层会话） */
export function _clearFileDraftsForTest(): void {
  _resetEditorSessionsForTest()
}
