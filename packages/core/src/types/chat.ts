import type { ProjectConfig, ProjectSnapshot } from './project'
import type { RetrievalResult } from './rag'
import type { ModelView } from '../core/agent/model-view'
import type { ConfirmHandler } from '../core/agent/tool-execution'
import type { ChangeDiff, FileChange } from '../core/tools/types'

export type ChatToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'
  | 'GetFileChangeHistory'

export type UserTextMessage = {
  id: string
  role: 'user'
  kind: 'text'
  text: string
  /** 用户在内容面板选中的引用内容，作为独立引用块展示在用户气泡内 */
  quote?: string
  /** 插话（steer）标记：渲染与普通用户气泡零视觉区别，仅供任务组分组规则判定（不是组边界）。 */
  steered?: boolean
  createdAt: string
}

export type AssistantTextMessage = {
  id: string
  role: 'assistant'
  kind: 'text'
  text: string
  createdAt: string
}

export type AssistantActionSummaryMessage = {
  id: string
  role: 'assistant'
  kind: 'action-summary'
  summary: string
  targetPath?: string
  relatedPaths?: string[]
  createdAt: string
}

export type ToolCallMessage = {
  id: string
  role: 'system'
  kind: 'tool-call'
  toolName: ChatToolName
  inputSummary: string
  /** 与 tool-result 配对的调用 id（event.call.id）；旧会话消息无此字段，UI 各自独立成行 */
  toolCallId?: string
  createdAt: string
}

export type ToolResultMessage = {
  id: string
  role: 'system'
  kind: 'tool-result'
  toolName: ChatToolName
  ok: boolean
  resultSummary: string
  /** 与 tool-call 配对的调用 id（event.call.id）；旧会话消息无此字段，UI 各自独立成行 */
  toolCallId?: string
  createdAt: string
}

export type ErrorMessage = {
  id: string
  role: 'system'
  kind: 'error'
  message: string
  recoverable: boolean
  createdAt: string
}

export type ContextSummaryMessage = {
  id: string
  role: 'system'
  kind: 'context-summary'
  summary: string
  createdAt: string
}

/**
 * 轮次安全阀提示（agentMaxTurns 达到上限）：永不折叠进任务组——
 * 它是「本轮为什么停在这」的用户可见结论，不是过程消息。
 * 历史会话里同文案的旧消息 kind 为 context-summary，仍按过程折叠，不迁移。
 */
export type TurnLimitMessage = {
  id: string
  role: 'system'
  kind: 'turn-limit'
  summary: string
  createdAt: string
}

/**
 * 改动汇总消息（取代 action-summary 生态位；任务完成 diff 面板在消息流里的占位）。
 * 只存 runId：面板数据渲染时从会话 changeLedger 按 runId 解析，不重复存 diff。
 * 随消息持久化，重载后每一轮的面板都在原位。
 */
export type ChangeSummaryMessage = {
  id: string
  role: 'system'
  kind: 'change-summary'
  runId: string
  /** 被停止的轮次：有改动渲染为面板并带「已停止」标记，无改动渲染为一行「本轮已被用户停止」 */
  aborted?: boolean
  createdAt: string
}

export type ChatMessage =
  | UserTextMessage
  | AssistantTextMessage
  | AssistantActionSummaryMessage
  | ToolCallMessage
  | ToolResultMessage
  | ErrorMessage
  | ContextSummaryMessage
  | TurnLimitMessage
  | ChangeSummaryMessage

export type ChatTargetContext = {
  type: 'chapter' | 'prompt-system' | 'prompt-scene' | 'element' | 'project'
  primaryPath?: string
  groupName?: string
  displayName: string
  derivedFrom: 'preview' | 'selection' | 'explicit-user-intent'
}

export type ChatSessionStatus = 'idle' | 'running' | 'waiting-user' | 'awaiting-confirmation' | 'error'

/** 收件箱里的一条排队消息（followup 或 steer）。 */
export type QueuedMessage = {
  id: string
  text: string
  /** 排队时快照的引用内容 */
  quote?: string
  /**
   * 入队时打开的文件路径快照：每条消息执行时用它解析「当前文件」，
   * 而不是用执行那一刻（或最后一次入队时）的文件——排队多条时各用各的。
   * 可选字段：旧会话队列无此字段，执行时回退到唤醒 driver 时的快照。
   */
  activeFilePath?: string | null
  /** 入队时间（ISO） */
  at: string
}

/**
 * 双队列收件箱（照抄 dsh 语义）：
 * - nextTurn：followup 排队消息，每条独占一个未来 turn；
 * - nextStep：steer 插话，下一个 step 边界整批生效。
 * 随会话 JSON 落盘（普通字段，不引入事件溯源）；刷新/重开后保留但不自动消费。
 */
export type InboxState = {
  nextTurn: QueuedMessage[]
  nextStep: QueuedMessage[]
}

/**
 * 改动账本的一条记录（append-only，与 modelView 彻底无关 → 天然免疫压缩）。
 * diff 仅 created/updated 有；renamed/deleted 无（删除原文去回收站 trashPath 看）。
 */
export type FileChangeRecord = {
  id: string
  /** 哪一轮任务产生（driver 每 turn 一个 runId） */
  runId: string
  /** ISO 时间 */
  at: string
  change: FileChange
  diff?: ChangeDiff
}

export type ChatSessionState = {
  sessionId: string
  projectId: string
  messages: ChatMessage[]
  /**
   * 双队列收件箱。可选字段：旧会话 JSON 无此字段，视为空队列，无需迁移。
   */
  inbox?: InboxState
  /**
   * 改动账本：append-only，随会话 JSON 落盘。可选字段：旧会话无此字段，视为空数组，无需迁移。
   * 「本轮改了哪些文件」的唯一可靠来源（修复压缩丢清单 + 总结只报一个文件两个 bug）。
   */
  changeLedger?: FileChangeRecord[]
  /**
   * 模型视图：发给 LLM 的消息序列唯一来源，持久化的是压缩后的当前视图。
   * 与显示层 messages（全量 transcript）彻底分离。旧会话文件的 agentMessages
   * 在加载时迁移到此字段。
   */
  modelView?: ModelView
  status: ChatSessionStatus
  currentTarget: ChatTargetContext | null
  lastRagResult: RetrievalResult | null
  /** 当前会话已注入的 system message（systemPrompt + scenePrompt 拼接结果）hash，用于检测同会话内提示词变化并刷新。 */
  systemPromptHash?: string
  /** 会话标题，列表展示用；新建默认“新对话”，首轮用户消息后自动用首句截断更新 */
  title: string
  /** 会话创建时间（ISO），落盘与列表排序用 */
  createdAt: string
  /** 会话最近更新时间（ISO），每轮保存刷新；列表按此降序 */
  updatedAt: string
}

export type ToolRuntimeContext = {
  project: ProjectSnapshot
  config: ProjectConfig
  target: ChatTargetContext | null
  session: ChatSessionState
}

export type ToolDefinition<TInput, TOutput> = {
  name: ChatToolName
  description: string
  validateInput: (input: unknown) => TInput
  call: (input: TInput, context: ToolRuntimeContext) => Promise<TOutput>
  summarizeInput: (input: TInput) => string
  summarizeOutput: (output: TOutput) => string
}

export type ChatTurnInput = {
  instruction: string
  /** 本轮引用的选中内容，会注入到发给模型的 user context */
  quote?: string
  project: ProjectSnapshot
  config: ProjectConfig
  systemPrompt: string
  scenePrompt?: string
  /** 项目总览（prompts/NovAI.md），每轮注入到 system prompt 的项目级累积记忆。 */
  novaiOverview?: string
  activeFilePath?: string | null
  /** 用户停止信号，透传到 Agent Loop。 */
  signal?: AbortSignal
  /** 写工具确认回调，透传到 Agent Loop。 */
  confirm?: ConfirmHandler
}

export type ChatTurnResult = {
  session: ChatSessionState
  target: ChatTargetContext | null
}
