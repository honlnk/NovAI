import { buildAgentSystemPrompt, buildAgentUserContext } from './prompt'
import { createAgentTools, type AgentRunnableToolMap } from './tools'
import {
  buildElementManagerSystemPrompt,
  buildElementSchemaReminder,
  createElementManagerTools,
  createDelegateToElementManagerTool,
  mergeElementManagerOverrides,
  type DelegationSessionRunner,
} from './element-manager'
import { readElementSchema } from '../fs/project-fs'
import { hashContent } from '../util/hash'
import { insertAfterSystem, replaceMessage, type ModelView } from './model-view'
import type { AgentMessage } from './messages'
import type { ChatSessionState, ChatTargetContext } from '../../types/chat'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 角色注册表（Role Registry，《角色注册机制施工计划》W1）：项目里所有智能体角色的
 * 统一声明处。角色 = 一个统一注册的智能体单元，声明自己的身份、system prompt 装配、
 * 工具面、注入面、约束文档与配置覆盖；所有角色共用同一套运行时核心
 * （runChatDriver/query），差异全部收进各自的声明（「统一注册、差异在声明」）。
 *
 * 角色是产品内置，不开放用户自定义。新增角色 = 在 AGENT_ROLES 登记一份声明（纯增量），
 * 运行时核心（session.ts 的 runDriverTurn）只读声明装配，不认识任何具体角色。
 */

/** 角色 id：会话 agent 字段的取值；未指定（缺省）即主角色。 */
export type AgentRoleId = 'main' | 'element-manager'

/** 工具面组装的会话层运行态（signal/委派会话驱动器是会话层闭包，不进 ToolRuntime）。 */
export type RoleToolContext = {
  signal?: AbortSignal
  /** 委派会话驱动器（service 层实现并注入）：主角色的委派工具靠它创建并驱动特化角色真会话。 */
  runDelegationSession?: DelegationSessionRunner
}

/** 角色专属约束文档：以 user-role reminder 恒注入的守则文件（要素管理员的 ELEMENT.md）。 */
export type RoleConstraintDoc = {
  /** 项目内相对路径（文档定位与日志用） */
  path: string
  /** 读取全文；文件缺失返回 null（注入方降级为 missingNote） */
  read: (handle: ProjectSnapshot['handle']) => Promise<string | null>
  /** 全文 → user-role reminder 文本 */
  buildReminder: (content: string) => string
  /** 文件缺失时的兜底提示（防御性不阻塞运行） */
  missingNote: string
}

/** 角色声明：身份、装配面与边界的单一声明处（运行层强制，不依赖模型自觉）。 */
export type AgentRoleProfile = {
  /** 角色 id（注册键） */
  id: AgentRoleId
  /** 展示名（UI 分组头 / 角色横幅 / 确认卡标签） */
  displayName: string
  /** system prompt 装配（身份段含模型名；特化角色忽略 system.md） */
  buildSystemPrompt(input: { model?: string; systemPrompt?: string }): string
  /** 组装该角色的完整工具面（角色差异的单一来源；会话闭包经 context 注入） */
  createTools(context?: RoleToolContext): AgentRunnableToolMap
  /** 用户消息进模型视图的包装（主角色包完整用户上下文，特化角色裸文本——任务自包含） */
  wrapUserContent(input: {
    instruction: string
    quote?: string
    project: ProjectSnapshot
    target: ChatTargetContext | null
  }): string
  /** 是否注入项目记忆（prompts/NovAI.md）reminder */
  injectNovaiOverview: boolean
  /** 是否注入写作大纲（reminder 动态附带 + 切换留痕） */
  injectOutline: boolean
  /** 专属约束文档（user-role reminder 恒注入）；主角色无（其守则走 system.md 链路） */
  constraintDoc?: RoleConstraintDoc
  /** 可否被主智能体委派（主角色是委派发起方，自身不可被委派） */
  delegatable: boolean
  /** 运行配置合成（角色专属覆盖块，如要素管理员的模型/权限档）；无覆盖的角色省略 */
  mergeConfig?(config: ProjectConfig): ProjectConfig
}

/** 主智能体：权限最高的角色，默认对话对象，握全量工具 + 委派工具。 */
const mainRole: AgentRoleProfile = {
  id: 'main',
  displayName: '主智能体',
  buildSystemPrompt: buildAgentSystemPrompt,
  createTools(context = {}) {
    return {
      ...createAgentTools(),
      // 委派工具是主角色专属（可把任务委派给其他角色）；委派会话驱动器为 service 层注入的闭包
      DelegateToElementManager: createDelegateToElementManagerTool(context),
    }
  },
  wrapUserContent: buildAgentUserContext,
  injectNovaiOverview: true,
  injectOutline: true,
  delegatable: false,
}

/** 要素管理员：特化角色——受限工具白名单 + elements/ 路径闸 + ELEMENT.md 约束。 */
const elementManagerRole: AgentRoleProfile = {
  id: 'element-manager',
  displayName: '要素管理员',
  buildSystemPrompt: buildElementManagerSystemPrompt,
  createTools() {
    // 白名单 + elements/ 写路径闸在 createElementManagerTools 内运行层强制；
    // 不含委派工具（防递归委派）
    return createElementManagerTools()
  },
  wrapUserContent(input) {
    return input.instruction
  },
  injectNovaiOverview: false,
  injectOutline: false,
  constraintDoc: {
    path: 'prompts/ELEMENT.md',
    read: readElementSchema,
    buildReminder: buildElementSchemaReminder,
    missingNote: '（规范文件 prompts/ELEMENT.md 缺失，按内置守则工作）',
  },
  delegatable: true,
  mergeConfig: mergeElementManagerOverrides,
}

/** 角色注册表。新增角色在此登记一份声明即可（纯增量），运行时核心无需改动。 */
export const AGENT_ROLES: Record<AgentRoleId, AgentRoleProfile> = {
  main: mainRole,
  'element-manager': elementManagerRole,
}

/** 按角色取声明；未指定（缺省）即主角色——主角色是默认对话对象。 */
export function getAgentRole(agent: AgentRoleId | undefined | null): AgentRoleProfile {
  const role = agent ? AGENT_ROLES[agent] : AGENT_ROLES.main
  if (!role) {
    throw new Error(`未知角色：${String(agent)}`)
  }
  return role
}

/** 列出全部注册角色（会话列表分组、委派目标枚举用）。 */
export function listAgentRoles(): AgentRoleProfile[] {
  return Object.values(AGENT_ROLES)
}

/**
 * 角色约束文档 reminder 同步（持久会话版，机制对齐 syncNovaiReminder）：
 * 恒为视图中唯一一条——首轮注入（system 之后、先于全部历史）、内容变化原地替换、
 * 被压缩吞掉后自动重插；digest 存会话（constraintDocDigest）。文件缺失时注入 missingNote
 * 兜底（防御性不阻塞运行）。content 为已读好的全文（读取由调用方完成）。
 */
export function syncConstraintDocReminder(input: {
  view: ModelView
  session: ChatSessionState
  doc: RoleConstraintDoc
  content: string | null
}): void {
  const body = input.content?.trim() ? input.content : null
  const reminderBody = body ?? input.doc.missingNote
  const digest = hashContent(reminderBody)
  const existingIndex = input.view.messages.findIndex(
    (message) => message.role === 'user' && message.content.includes(input.doc.path),
  )
  if (existingIndex >= 0 && digest === input.session.constraintDocDigest) {
    return
  }

  const reminder: AgentMessage = {
    role: 'user',
    content: input.doc.buildReminder(reminderBody),
  }
  if (existingIndex >= 0) {
    replaceMessage(input.view, existingIndex, reminder)
  } else {
    insertAfterSystem(input.view, reminder)
  }
  input.session.constraintDocDigest = digest
}
