export type AgentToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'

export type AgentToolCall = {
  id: string
  name: AgentToolName
  input: Record<string, unknown>
}

export type AgentSystemMessage = {
  role: 'system'
  content: string
}

export type AgentUserMessage = {
  role: 'user'
  content: string
}

export type AgentAssistantMessage = {
  role: 'assistant'
  content: string
  toolCalls?: AgentToolCall[]
}

export type AgentToolResultMessage = {
  role: 'tool'
  toolCallId: string
  name: AgentToolName
  content: string
}

export type AgentMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage

export type AgentToolSchema = {
  type: 'function'
  function: {
    name: AgentToolName
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties: boolean
    }
  }
}

export type AgentAssistantResponse = {
  content: string
  toolCalls: AgentToolCall[]
  finishReason?: string
  diagnostics?: AgentLlmDiagnostics
}

export type AgentLlmDiagnostics = {
  responseMode: 'stream' | 'non_streaming' | 'non_streaming_fallback'
  chunkCount: number
  dataLineCount: number
  parseErrorCount: number
  toolCallDeltaCount: number
  pendingToolCallCount: number
  finalizedToolCallCount: number
  droppedToolCallCount: number
  droppedToolCalls: Array<{
    index: number
    hasId: boolean
    hasName: boolean
    argumentsLength: number
    argumentsParseable: boolean
  }>
  fallback?: {
    from: 'stream'
    to: 'non_streaming'
    reason: string
    succeeded: boolean
    originalToolCallCount: number
    originalDroppedToolCallCount: number
    errorMessage?: string
  }
}

export function createAgentId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
