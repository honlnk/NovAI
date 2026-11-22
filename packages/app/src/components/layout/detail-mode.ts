/**
 * 详情视图模式（六个模块右侧详情布局统一计划 阶段 1，自 components/plan/detail-mode.ts 迁入）：
 * 正文与卡片的详情共用「预览 / 编辑」两态。视图何时切换、保存后停在哪一态
 * 由各领域会话决定，本类型只约定取值。
 */
export type DetailMode = 'preview' | 'edit'
