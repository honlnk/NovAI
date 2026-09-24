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
  /**
   * gemini 函数调用的思考签名（thoughtSignature）：Gemini 2.5 思考模型在
   * functionCall part 上携带，后续请求必须原样回传，否则 API 校验拒绝。
   * 协议内部字段，随 assistant 消息持久化，不进 UI、不进工具 schema。
   */
  thoughtSignature?: string
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
   * 持久化供 UI 展示，并按协议要求随历史回传（DeepSeek 思考模式工具轮硬要求
   * reasoning_content；anthropic 回传 thinking block）——不产思考的模型天然缺省。
   */
  reasoning?: string
  /**
   * anthropic 思考块签名（thinking block 的 signature）：真 Anthropic 思考模式
   * 工具轮强制验签回传；DeepSeek anthropic 端点不校验但回传亦安全。
   */
  thinkingSignature?: string
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
  /** anthropic 思考块签名，随 assistant 消息持久化用于回传（见 AgentAssistantMessage.thinkingSignature）。 */
  thinkingSignature?: string
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
