/**
 * 详情保存阶段（六个模块右侧详情布局统一计划 阶段 1）：
 * 布局层统一定义的五态展示类型。普通文件与卡片各自把自己的会话状态
 * （editor-session / card-board 会话）按「写盘在途 > 存在冲突 > 普通失败 >
 * 存在待保存内容 > 已保存」的优先顺序派生为这五态，不把两套会话对象或
 * 领域状态类型传入公共组件。守护期间沿用普通保存口径（§三.3.11）。
 */
export type DetailSavePhase = 'clean' | 'pending' | 'saving' | 'failed' | 'conflict'

/** 五态集中文案映射：唯一实现，公共组件与测试共用，领域不得另行拼接 */
export const DETAIL_SAVE_PHASE_LABELS: Record<DetailSavePhase, string> = {
  clean: '已保存',
  pending: '等待保存',
  saving: '正在保存',
  failed: '保存失败',
  conflict: '保存冲突',
}

/** 五态集中颜色映射（text-* class）：已保存浅灰 / 等待琥珀 / 正在保存蓝 / 失败红 / 冲突琥珀 */
export const DETAIL_SAVE_PHASE_TEXT_CLASSES: Record<DetailSavePhase, string> = {
  clean: 'text-gray-400',
  pending: 'text-amber-600',
  saving: 'text-blue-600',
  failed: 'text-red-600',
  conflict: 'text-amber-700',
}
