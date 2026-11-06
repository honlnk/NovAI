/**
 * 详情视图状态机（交互优化计划 §详情预览；布局统一计划 §5.2 随编辑会话迁入 store）：
 * - 默认预览（渲染 Markdown），双击正文或点「编辑」进入 textarea；
 * - 保存成功（保存中结束且未保存修改清零——草稿已写回卡片）回到预览；
 * - 冲突 / 失败路径未保存修改保持 true，不误触发。
 * 纯函数便于单测；plan store 持有 detailMode 并由此组合出保存回预览的转移。
 * 切卡 / 重开卡片的视图恢复由 store 的卡片级编辑会话承担（不再有「切卡必回预览」）。
 */

export type DetailMode = 'preview' | 'edit'

/**
 * 保存结束后是否应回到预览：仅当「保存中 → 保存完成」且未保存修改同时清零。
 * 无修改点保存（isSaving 未经历 true）不切视图；冲突/失败未保存修改仍为 true，保持编辑态。
 */
export function shouldReturnToPreviewAfterSave(
  wasSaving: boolean,
  isSaving: boolean,
  hasUnsavedChanges: boolean,
): boolean {
  return wasSaving && !isSaving && !hasUnsavedChanges
}
