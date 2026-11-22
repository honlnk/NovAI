/**
 * Activity Bar 的分类类型。
 *
 * 对应左侧 Activity Bar 的图标分类，每个分类切换右侧 CategoryPanel 的内容。
 * 注意：`settings` 是动作型入口（打开模态框），不会作为 CategoryPanel 的渲染分支，
 * 仅在此保留以统一 Activity Bar 的图标语义。
 * `plan`（创作计划板）的 CategoryPanel 分支显示入口摘要、刷新与最近计划，
 * 完整看板在主内容区（替换对话面板），见 PlanBoardPanel；计划详情与新建
 * 在右侧内容面板（布局统一计划）。`foreshadowing`（伏笔账本）与 `rhythm`（节奏卡账本）与计划同构，
 * 是创作心智模块（伏笔追踪 + 全本节奏卡）的看板分类。
 * `skill`（技能包）排在提示词之后、计划之前（技能包 UI/UX 施工计划决策 3：
 * prompts/ 是作者亲手写的宪法层，skills/ 是外部素材，心智分开）。
 */
export type Category = 'conversation' | 'chapter' | 'element' | 'prompt' | 'skill' | 'plan' | 'foreshadowing' | 'rhythm'

/**
 * 设置是动作型入口，不切换 CategoryPanel，单独标识以便 ActivityBar 区分行为。
 */
export type SettingsAction = 'settings'

export type ActivityItem = Category | SettingsAction
