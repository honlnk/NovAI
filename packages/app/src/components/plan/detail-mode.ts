/**
 * 详情视图状态机（交互优化计划 §详情预览）：
 * - 默认预览（渲染 Markdown），双击正文或点「编辑」进入 textarea；
 * - 保存成功（保存中结束且未保存修改清零——草稿已写回卡片）回到预览；
 * - 冲突 / 失败路径未保存修改保持 true，不误触发。
 * 纯函数便于单测；PlanBoardPanel 由此组合出 ref 状态。
 */

export type DetailMode = 'preview' | 'edit'

/** 卡片切换：回到预览（并清掉上一张卡片的删除确认残留）。 */
export function resetDetailMode(): DetailMode {
  return 'preview'
}

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
