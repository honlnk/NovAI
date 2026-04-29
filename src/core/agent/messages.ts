export type AgentToolName = 'ReadFile' | 'EditFile' | 'CreateFile' | 'ListDirectory'

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
}

export function createAgentId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
