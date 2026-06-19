import type { ProjectConfig, ProjectSnapshot } from './project'
import type { RetrievalResult } from './rag'
import type { AgentMessage } from '../core/agent/messages'
import type { ConfirmHandler } from '../core/agent/tool-execution'

export type ChatToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'

export type UserTextMessage = {
  id: string
  role: 'user'
  kind: 'text'
  text: string
  /** 用户在内容面板选中的引用内容，作为独立引用块展示在用户气泡内 */
  quote?: string
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
  createdAt: string
}

export type ToolResultMessage = {
  id: string
  role: 'system'
  kind: 'tool-result'
  toolName: ChatToolName
  ok: boolean
  resultSummary: string
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

export type ChatMessage =
  | UserTextMessage
  | AssistantTextMessage
  | AssistantActionSummaryMessage
  | ToolCallMessage
  | ToolResultMessage
  | ErrorMessage
  | ContextSummaryMessage

export type ChatTargetContext = {
  type: 'chapter' | 'prompt-system' | 'prompt-scene' | 'element' | 'project'
  primaryPath?: string
  groupName?: string
  displayName: string
  derivedFrom: 'preview' | 'selection' | 'explicit-user-intent'
}

export type ChatSessionStatus = 'idle' | 'running' | 'waiting-user' | 'awaiting-confirmation' | 'error'

export type PendingFileChange =
  | {
      id: string
      type: 'edit'
      path: string
      oldText: string
      newText: string
      createdAt: string
    }
  | {
      id: string
      type: 'create'
      path: string
      content: string
      createdAt: string
    }

export type ChatSessionState = {
  sessionId: string
  projectId: string
  messages: ChatMessage[]
  agentMessages?: AgentMessage[]
  status: ChatSessionStatus
  currentTarget: ChatTargetContext | null
  lastRagResult: RetrievalResult | null
  pendingFileChange?: PendingFileChange
  lastWrittenPath?: string
  lastTaskType?: 'read-only' | 'edit-target' | 'create-chapter'
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
  activeFilePath?: string | null
  /** 用户停止信号，透传到 Agent Loop。 */
  signal?: AbortSignal
  /** 写工具确认回调，透传到 Agent Loop。 */
  confirm?: ConfirmHandler
}

export type ChatTurnResult = {
  session: ChatSessionState
  target: ChatTargetContext | null
  writtenPath?: string
}
