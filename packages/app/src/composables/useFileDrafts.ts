/**
 * 文件编辑草稿表（交互优化计划 §6「未保存内容保护」）：编辑会话按「项目:路径」
 * 保留草稿，切换文件/分类/收起面板不静默丢失；回到该文件时草稿原样恢复。
 *
 * 模块级单例（useConversationFilter 同款）：FilePanelBody 常驻挂载（v-show），
 * 草稿表比组件生命周期长，项目切换靠复合键隔离。只存内存——正文不自动保存，
 * 刷新前的风险由 beforeunload 守卫提示（真实离开时给保存/放弃选择）。
 */

type DraftEntry = {
  /** 用户当前草稿 */
  content: string
  /** 草稿所依据的磁盘内容快照（脏判定基线） */
  baseContent: string
}

const draftsByProject = new Map<string, Map<string, DraftEntry>>()

function draftKey(path: string): string {
  return path
}

function projectBucket(projectId: string): Map<string, DraftEntry> {
  let bucket = draftsByProject.get(projectId)
  if (!bucket) {
    bucket = new Map()
    draftsByProject.set(projectId, bucket)
  }
  return bucket
}

/** 取某文件的编辑草稿；无编辑会话返回 undefined */
export function getFileDraft(projectId: string, path: string): string | undefined {
  return draftsByProject.get(projectId)?.get(draftKey(path))?.content
}

/** 记录某文件的编辑草稿（每次编辑实时调用）；草稿与磁盘一致时清除条目 */
export function setFileDraft(projectId: string, path: string, content: string, baseContent: string): void {
  if (content === baseContent) {
    clearFileDraft(projectId, path)
    return
  }
  projectBucket(projectId).set(draftKey(path), { content, baseContent })
}

/** 清除草稿（保存成功、放弃更改、读取最新后调用） */
export function clearFileDraft(projectId: string, path: string): void {
  draftsByProject.get(projectId)?.delete(draftKey(path))
}

/** 某文件当前是否有未保存草稿 */
export function isFileDraftDirty(projectId: string, path: string): boolean {
  return draftsByProject.get(projectId)?.has(draftKey(path)) ?? false
}

/** 项目内是否存在任何未保存草稿（beforeunload 守卫用） */
export function hasDirtyDrafts(projectId: string): boolean {
  const bucket = draftsByProject.get(projectId)
  return bucket !== undefined && bucket.size > 0
}

/** 测试专用：清空整张草稿表 */
export function _clearFileDraftsForTest(): void {
  draftsByProject.clear()
}
