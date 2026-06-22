/**
 * Activity Bar 的分类类型。
 *
 * 对应左侧 Activity Bar 的 5 个图标，每个分类切换右侧 CategoryPanel 的内容。
 * 注意：`settings` 是动作型入口（打开模态框），不会作为 CategoryPanel 的渲染分支，
 * 仅在此保留以统一 Activity Bar 的图标语义。
 */
export type Category = 'conversation' | 'chapter' | 'element' | 'prompt'

/**
 * 设置是动作型入口，不切换 CategoryPanel，单独标识以便 ActivityBar 区分行为。
 */
export type SettingsAction = 'settings'

export type ActivityItem = Category | SettingsAction
