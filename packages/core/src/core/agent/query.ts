import { streamAgentCompletion, AgentAbortedError } from './llm'
import { runAgentTools } from './tool-orchestration'
import type { ConfirmHandler, ToolExecutionEvent } from './tool-execution'
import {
  computeRetainTokens,
  isContextOverflowError,
  runCompaction,
  shouldCompact,
} from './compaction'
import { appendAssistantMessage, appendToolResults, toRequestMessages, type ModelView } from './model-view'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentLlmDiagnostics,
} from './messages'
import type { AgentRunnableToolMap } from './tools'
import type { ReadFileState } from '../tools/types'

const DEFAULT_MAX_TURNS = 8

export type AgentQueryEvent =
  | { type: 'query-step-start'; step: number }
  | { type: 'model-start'; step: number; debug?: ModelStartDebugInfo }
  | { type: 'assistant-delta'; text: string }
  | { type: 'model-finish'; step: number; toolCallCount: number; finishReason?: string; diagnostics?: AgentLlmDiagnostics }
  | { type: 'model-tool-call-parse-warning'; step: number; finishReason?: string; diagnostics?: AgentLlmDiagnostics }
  | { type: 'tool-batch-start'; step: number; toolCallCount: number }
  | { type: 'tool-batch-finish'; step: number; toolResultCount: number }
  | { type: 'context-compacted'; compactedMessageCount: number; originalTokens: number; summaryTokens: number }
  | { type: 'aborted'; reason: 'user'; partialContent?: string }
  | { type: 'assistant-message'; message: AgentAssistantMessage }
  | ToolExecutionEvent
  | { type: 'done'; messages: AgentMessage[]; aborted?: boolean }

export async function query(input: {
  config: ProjectConfig
  project: ProjectSnapshot
  /** 模型视图：query 循环直接在其上追加/压缩，视图是发给 LLM 消息序列的唯一来源。 */
  view: ModelView
  tools: AgentRunnableToolMap
  maxTurns?: number
  signal?: AbortSignal
  /** 写工具确认回调，透传到工具执行层。 */
  confirm?: ConfirmHandler
  onEvent?: (event: AgentQueryEvent) => void
}): Promise<AgentMessage[]> {
  const view = input.view
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const readFileStates = new Map<string, ReadFileState>()
  const enableDebugLogging = Boolean(input.config.settings.enableDebugLogging)
  const thresholdTokens = input.config.settings.conversationTokenLimit
  const keepRecentTurns = input.config.settings.compressionKeepRecentTurns

  const availableTools = Object.values(input.tools)

  /** 请求前压力触发：达到阈值先压缩。返回是否实际压缩。 */
  async function compactIfOverThreshold(): Promise<boolean> {
    if (!shouldCompact(view, thresholdTokens)) {
      return false
    }
    const retainTokens = computeRetainTokens(view.messages, thresholdTokens, keepRecentTurns)
    const result = await runCompaction({ config: input.config, view, retainTokens, signal: input.signal })
    if (result) {
      input.onEvent?.({ type: 'context-compacted', ...result })
      return true
    }
    return false
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const step = turn + 1

    // 每一轮开始前检查用户是否已停止（工具执行完毕后停止的边界）
    if (input.signal?.aborted) {
      input.onEvent?.({ type: 'aborted', reason: 'user' })
      input.onEvent?.({ type: 'done', messages: view.messages, aborted: true })
      return view.messages
    }

    await compactIfOverThreshold()

    let messages = toRequestMessages(view)

    input.onEvent?.({ type: 'query-step-start', step })
    input.onEvent?.({
      type: 'model-start',
      step,
      debug: enableDebugLogging
        ? createModelStartDebugInfo({
          config: input.config,
          messages,
          toolCount: availableTools.length,
        })
        : undefined,
    })

    let assistantResponse
    let overflowRetried = false
    while (true) {
      try {
        assistantResponse = await streamAgentCompletion(
          {
            baseUrl: input.config.llm.baseUrl,
            apiKey: input.config.llm.apiKey,
            model: input.config.llm.model,
            messages,
            tools: availableTools.map((tool) => tool.schema),
            signal: input.signal,
          },
          (event) => {
            // 流式 delta 向上透传（UI 实时渲染用）；最终完整文本仍由 assistant-message 事件落盘。
            if (event.type === 'delta') {
              input.onEvent?.({ type: 'assistant-delta', text: event.text })
            }
          },
        )
        break
      } catch (error) {
        // 用户主动停止 —— 保留已生成的内容作为 assistant 消息，优雅结束
        if (error instanceof AgentAbortedError) {
          if (error.partialContent.trim()) {
            const partialMessage: AgentAssistantMessage = {
              role: 'assistant',
              content: error.partialContent,
            }
            appendAssistantMessage(view, partialMessage)
            input.onEvent?.({ type: 'assistant-message', message: partialMessage })
          }
          input.onEvent?.({ type: 'aborted', reason: 'user', partialContent: error.partialContent })
          input.onEvent?.({ type: 'done', messages: view.messages, aborted: true })
          return view.messages
        }

        // 溢出触发：provider 报 context 超限 → 强制压缩一次并重试该请求（上限 1 次，避免死循环）
        if (!overflowRetried && isContextOverflowError(error)) {
          overflowRetried = true
          const retainTokens = computeRetainTokens(view.messages, thresholdTokens, keepRecentTurns)
          const result = await runCompaction({ config: input.config, view, retainTokens, signal: input.signal })
          if (result) {
            input.onEvent?.({ type: 'context-compacted', ...result })
            messages = toRequestMessages(view)
            continue
          }
        }

        throw error
      }
    }

    input.onEvent?.({
      type: 'model-finish',
      step,
      toolCallCount: assistantResponse.toolCalls.length,
      finishReason: assistantResponse.finishReason,
      diagnostics: enableDebugLogging ? assistantResponse.diagnostics : undefined,
    })

    if (assistantResponse.finishReason === 'tool_calls' && assistantResponse.toolCalls.length === 0) {
      input.onEvent?.({
        type: 'model-tool-call-parse-warning',
        step,
        finishReason: assistantResponse.finishReason,
        diagnostics: assistantResponse.diagnostics,
      })
    }

    const assistantMessage: AgentAssistantMessage = {
      role: 'assistant',
      content: assistantResponse.content,
      toolCalls: assistantResponse.toolCalls,
    }

    appendAssistantMessage(view, assistantMessage)
    input.onEvent?.({ type: 'assistant-message', message: assistantMessage })

    if (assistantResponse.toolCalls.length === 0) {
      input.onEvent?.({ type: 'done', messages: view.messages })
      return view.messages
    }

    input.onEvent?.({
      type: 'tool-batch-start',
      step,
      toolCallCount: assistantResponse.toolCalls.length,
    })

    const toolResults = await runAgentTools({
      calls: assistantResponse.toolCalls,
      project: input.project,
      tools: input.tools,
      readFileStates,
      signal: input.signal,
      confirm: input.confirm,
      onEvent: input.onEvent,
    })

    input.onEvent?.({
      type: 'tool-batch-finish',
      step,
      toolResultCount: toolResults.length,
    })

    appendToolResults(view, toolResults)
  }

  const limitMessage: AgentAssistantMessage = {
    role: 'assistant',
    content: `已达到本轮 Agent 最大循环次数（${maxTurns}）。我先停在这里，避免无限调用工具。`,
  }

  appendAssistantMessage(view, limitMessage)
  input.onEvent?.({ type: 'assistant-message', message: limitMessage })
  input.onEvent?.({ type: 'done', messages: view.messages })
  return view.messages
}

type ModelStartDebugInfo = {
  llm: {
    baseUrlHost: string
    model: string
    authConfigured: boolean
  }
  request: {
    messageCount: number
    roleCounts: Record<AgentMessage['role'], number>
    toolCount: number
    toolChoice: 'auto'
    lastUserMessagePreview: string
    lastUserMessageLength: number
    systemPromptLength: number
  }
  projectConfig: {
    updatedAt: string
  }
}

function createModelStartDebugInfo(input: {
  config: ProjectConfig
  messages: AgentMessage[]
  toolCount: number
}): ModelStartDebugInfo {
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === 'user')
  const systemMessage = input.messages.find((message) => message.role === 'system')

  return {
    llm: {
      baseUrlHost: readUrlHost(input.config.llm.baseUrl),
      model: input.config.llm.model,
      authConfigured: Boolean(input.config.llm.apiKey.trim()),
    },
    request: {
      messageCount: input.messages.length,
      roleCounts: countMessageRoles(input.messages),
      toolCount: input.toolCount,
      toolChoice: 'auto',
      lastUserMessagePreview: previewText(lastUserMessage?.content ?? ''),
      lastUserMessageLength: lastUserMessage?.content.length ?? 0,
      systemPromptLength: systemMessage?.content.length ?? 0,
    },
    projectConfig: {
      updatedAt: input.config.project.updatedAt,
    },
  }
}

function countMessageRoles(messages: AgentMessage[]): Record<AgentMessage['role'], number> {
  return messages.reduce<Record<AgentMessage['role'], number>>(
    (result, message) => {
      result[message.role] += 1
      return result
    },
    {
      system: 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )
}

function previewText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized
}

function readUrlHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url.trim()
  }
}
