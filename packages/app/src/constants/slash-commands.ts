import { ELEMENT_MANAGER_TASK_PROMPT, INIT_NOVEL_PROMPT } from '@novai/core/services/agent-service'
import type { AppIconName } from '../components/ui/app-icons'

/**
 * 斜杠命令注册表（R6 起源；要素整理参数化 W3 起新范式）。
 *
 * 斜杠菜单是纯命令补全器：选中命令后把命令文本填入输入框（尾部带空格），
 * 用户可在其后补充参数——命令是纯文本，可编辑可删除，行为与普通文字一致。
 * 命令分两类，发送链路按序拦截：
 * - prompt 展开型：行首命中的命令文本替换为驱动 prompt（expandSlashCommand；
 *   入口重构 W1 起 /管理要素 为一句委派指令，主 Agent 自行解读委派；/生成项目记忆 仍为全文）。
 * - 本地执行型（localAction）：客户端直接执行的动作，不展开 prompt、不发送消息
 *   （发送链路第一道拦截 matchLocalSlashCommand，先于提问改道——命令是显式操作，
 *   不会是对提问卡的自由文本回答）。
 */
export type SlashCommandId = 'init' | 'element-manager' | 'compact-context'

/** 本地执行型命令的动作标识（发送链路据此改道，无 prompt 展开） */
export type LocalSlashCommandAction = 'compact-context'

export type SlashCommand = {
  /** 命令唯一标识 */
  id: SlashCommandId
  /** 显示名（含 / 前缀，用于菜单展示、落输入框文本与前缀匹配） */
  label: string
  /** 简短描述 */
  description: string
  /** 受控语义图标名（交互优化计划 §9，Lucide 线性图形） */
  icon: AppIconName
  /** 裸发（命令文本后无参数）时光标处的行内浅灰提示；不配置则裸发无提示 */
  bareHint?: string
  /** 本地执行型命令的动作；不配置即 prompt 展开型 */
  localAction?: LocalSlashCommandAction
}

/** 当前可用的斜杠命令（/提取要素 已于 2026-10 退役，要素整理参数化 W4） */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'element-manager',
    label: '/管理要素',
    description: '管理 elements/ 要素库（要素管理员执行）；可在命令后补范围/目标，留空即全权委托整理整个要素库',
    icon: 'library',
    bareHint: '← 可在此补充范围/目标，留空则整理整个要素库',
  },
  {
    id: 'init',
    label: '/生成项目记忆',
    description: '扫描项目生成/更新 prompts/NovAI.md 项目总览；选中后填入输入框，可补充参数后发送',
    icon: 'clipboard-list',
  },
  {
    id: 'compact-context',
    label: '/压缩上下文',
    description: '立即把当前会话的早期历史压缩成检查点摘要；本地操作，不发送消息、不消耗对话轮次',
    icon: 'fold-vertical',
    bareHint: '← 直接发送执行，无需参数',
    localAction: 'compact-context',
  },
]

/** 落输入框的命令文本（尾部带空格，光标置后可直接补参数） */
export function slashCommandDraftText(label: string): string {
  return `${label} `
}

/**
 * 裸发斜杠命令的行内提示（入口重构 W1）：草稿恰为命令文本（可带尾随空白、无参数）
 * 且该命令配置了 bareHint 时返回提示文案，否则返回空串。多行/带参数草稿不提示。
 */
export function bareSlashCommandHint(draft: string): string {
  const text = draft.trimEnd()
  return SLASH_COMMANDS.find((entry) => entry.bareHint && text === entry.label)?.bareHint ?? ''
}

/**
 * 本地命令匹配（发送链路第一道拦截）：草稿恰为带 localAction 的命令文本
 * （可带尾随空白）时返回该动作。本地命令无参数——命令后带其他文字或多行
 * 不命中，视作普通文本交给后续链路（prompt 展开/发送）。
 */
export function matchLocalSlashCommand(draft: string): LocalSlashCommandAction | undefined {
  const text = draft.trim()
  return SLASH_COMMANDS.find((entry) => entry.localAction && text === entry.label)?.localAction
}

/**
 * 本地命令带参数检测（§3.2「非法命令或参数」）：草稿首行以本地命令开头但带了
 * 参数（含裸命令后另起多行）时返回该命令——发送链路据此在输入区附近说明原因
 * 并保留草稿，不静默退化为普通长提示（本地命令不在 prompt 展开表，原文会直发模型）。
 */
export function matchLocalSlashCommandWithArgs(draft: string): SlashCommand | undefined {
  const lines = draft.split('\n')
  const firstLine = (lines[0] ?? '').trim().trimStart()
  return SLASH_COMMANDS.find((entry) => {
    if (!entry.localAction) {
      return false
    }
    if (firstLine.startsWith(`${entry.label} `)) {
      return true
    }
    // 裸命令后还有后续行：同样是「带参数」形态（多行正文）
    return firstLine === entry.label && lines.length > 1
  })
}

/** 行首命中即替换的命令 → 驱动 prompt 映射（发送链路前缀拦截，W3 D6） */
const SLASH_COMMAND_EXPANSIONS: Array<{ command: string; prompt: string }> = [
  { command: '/管理要素', prompt: ELEMENT_MANAGER_TASK_PROMPT },
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
