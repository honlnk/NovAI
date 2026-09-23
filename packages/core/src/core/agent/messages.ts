import type { FileChange } from '../tools/types'

export type AgentToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'
  | 'GetFileChangeHistory'
  | 'WebSearch'
  | 'WebFetch'

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
  /**
   * 模型思考流（DeepSeek reasoning_content / anthropic thinking / gemini thought）。
   * 只持久化供 UI 展示，构造请求时各适配器一律丢弃——「只收不发」。
   */
  reasoning?: string
  toolCalls?: AgentToolCall[]
}

export type AgentToolResultMessage = {
  role: 'tool'
  toolCallId: string
  name: AgentToolName
  content: string
  /**
   * 写工具成功执行后携带的结构化文件变更。
   * 只读工具或失败的工具不携带（undefined）。
   * service 层据此推导 changedFiles，不再依赖 content 文本反推。
   */
  fileChange?: FileChange
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
  /** 思考流全文（存在时随 assistant 消息持久化，见 AgentAssistantMessage.reasoning）。 */
  reasoning?: string
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
