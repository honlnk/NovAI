import { GARDENER_TASK_PROMPT, INIT_NOVEL_PROMPT } from '@novai/core/services/agent-service'

/**
 * 斜杠命令注册表（R6 起源；要素整理参数化 W3 起新范式）。
 *
 * 斜杠菜单是纯命令补全器：选中命令后把命令文本填入输入框（尾部带空格），
 * 用户可在其后补充参数——命令是纯文本，可编辑可删除，行为与普通文字一致。
 * 发送链路对行首命中的命令做前缀拦截替换（expandSlashCommand）：
 * 裸命令文本本身不构成对主 Agent 的有效指令，替换为驱动 prompt 全文保证工程质量不丢。
 */
export type SlashCommandId = 'extract' | 'init' | 'gardener'

export type SlashCommand = {
  /** 命令唯一标识 */
  id: SlashCommandId
  /** 显示名（含 / 前缀，用于菜单展示、落输入框文本与前缀匹配） */
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
    description: '从章节中提取人物、地点、剧情等要素（固定流水线，即将由整理要素替代）',
    icon: '✨',
  },
  {
    id: 'gardener',
    label: '/整理要素',
    description: '整理 elements/ 要素库（专用子智能体执行）；选中后填入输入框，可在其后补充参数',
    icon: '🌿',
  },
  {
    id: 'init',
    label: '/生成项目记忆',
    description: '扫描项目生成/更新 prompts/NovAI.md 项目总览；选中后填入输入框，可补充参数后发送',
    icon: '📋',
  },
]

/** 落输入框的命令文本（尾部带空格，光标置后可直接补参数） */
export function slashCommandDraftText(label: string): string {
  return `${label} `
}

/** 行首命中即替换的命令 → 驱动 prompt 映射（发送链路前缀拦截，W3 D6） */
const SLASH_COMMAND_EXPANSIONS: Array<{ command: string; prompt: string }> = [
  { command: '/整理要素', prompt: GARDENER_TASK_PROMPT },
  { command: '/生成项目记忆', prompt: INIT_NOVEL_PROMPT },
]

/**
 * 发送链路前缀拦截（W3 D6）：草稿首行以已注册斜杠命令开头时，
 * 把命令文本替换为其驱动 prompt 全文，命令后的参数原样保留（\n\n 分隔），
 * 首行之后的其余行原样拼回。不在行首（或未注册）的命令文本不替换——
 * 正文提及命令名不是指令。
 */
export function expandSlashCommand(draft: string): string {
  const lines = draft.split('\n')
  const firstLine = lines[0] ?? ''
  const trimmed = firstLine.trimStart()
  const restLines = lines.length > 1 ? `\n${lines.slice(1).join('\n')}` : ''

  for (const { command, prompt } of SLASH_COMMAND_EXPANSIONS) {
    if (trimmed === command || trimmed.startsWith(`${command} `)) {
      const remainder = trimmed.slice(command.length).trim()
      if (!remainder) {
        return `${prompt}${restLines}`
      }
      return `${prompt}\n\n${remainder}${restLines}`
    }
  }
  return draft
}
