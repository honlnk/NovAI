/**
 * 斜杠命令注册表（R6）。
 *
 * 输入框输入 / 后弹出命令菜单，列出这里注册的命令。
 * 每个命令选中后展开对应的二级交互界面（目前只有 extract）。
 * 后续可扩展 /校对、/整理 等。
 */
export type SlashCommandId = 'extract' | 'init'

export type SlashCommand = {
  /** 命令唯一标识 */
  id: SlashCommandId
  /** 显示名（含 / 前缀，用于菜单展示和匹配） */
  label: string
  /** 简短描述 */
  description: string
  /** 图标（emoji） */
  icon: string
}

/** 当前可用的斜杠命令 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'extract',
    label: '/提取要素',
    description: '从章节中提取人物、地点、剧情等要素',
    icon: '✨',
  },
  {
    id: 'init',
    label: '/生成项目记忆',
    description: '扫描项目生成/更新 prompts/NovAI.md 项目总览',
    icon: '📋',
  },
]
