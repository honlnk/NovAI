/**
 * 手动保存完成后草稿去向的判定（数据安全计划 §3-1）：
 * 保存绑定「本次落盘的内容快照」，成功后只处理这份快照对应的草稿——
 * - 保存期间没有新输入（草稿==落盘内容或已无草稿）：清除草稿（含持久化备份）；
 * - 保存期间继续输入（草稿比落盘内容新）：保留新增输入为未保存，基线换到
 *   刚落盘的内容（rebase），不被成功回调清除。
 *
 * 纯函数 + 应用器：FilePanelBody 的成功回调只调用 applyDraftAfterSave，
 * 事件序语义在这里独立测试（不依赖组件挂载）。
 */
import { clearFileDraft, setFileDraft } from '../composables/useFileDrafts'

export type DraftAfterSave =
  | { action: 'clear' }
  | { action: 'rebase'; content: string; baseContent: string }

/**
 * 判定保存成功后该路径草稿的去向。
 * @param currentDraft 保存完成时刻内存草稿表里该路径的草稿（可能已被继续输入更新）
 * @param savedContent 本次实际落盘的内容快照（保存开始时固定）
 */
export function resolveDraftAfterSave(
  currentDraft: string | undefined,
  savedContent: string,
): DraftAfterSave {
  if (currentDraft === undefined || currentDraft === savedContent) {
    return { action: 'clear' }
  }
  return { action: 'rebase', content: currentDraft, baseContent: savedContent }
}

/** 把判定结果应用到草稿表（clear 同步删除持久化备份；rebase 重定基线） */
export function applyDraftAfterSave(projectId: string, path: string, resolution: DraftAfterSave): void {
  if (resolution.action === 'clear') {
    clearFileDraft(projectId, path)
    return
  }
  setFileDraft(projectId, path, resolution.content, resolution.baseContent)
}
