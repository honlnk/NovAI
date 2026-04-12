import type { ProjectConfig, ProjectSnapshot } from './project'
import type { RetrievalResult } from './rag'

export type ChatToolName = 'FileRead' | 'FileWrite' | 'FileEdit' | 'Bash' | 'RagSearch'

export type UserTextMessage = {
  id: string
  role: 'user'
  kind: 'text'
  text: string
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

export type ChatSessionStatus = 'idle' | 'running' | 'waiting-user' | 'error'

export type ChatSessionState = {
  sessionId: string
  projectId: string
  messages: ChatMessage[]
  status: ChatSessionStatus
  currentDraftText: string
  currentTarget: ChatTargetContext | null
  lastRagResult: RetrievalResult | null
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
  project: ProjectSnapshot
  config: ProjectConfig
  systemPrompt: string
  activeFilePath?: string | null
}

export type ChatTurnResult = {
  session: ChatSessionState
  target: ChatTargetContext | null
  writtenPath?: string
}
