import { streamAgentCompletion, AgentAbortedError } from './llm'
import { runAgentTools } from './tool-orchestration'
import type { ConfirmHandler, ToolExecutionEvent } from './tool-execution'
import {
  computeRetainTokens,
  isContextOverflowError,
  runCompaction,
  shouldCompact,
  type CompactionResult,
} from './compaction'
import { appendAssistantMessage, appendToolResults, appendUserMessage, toRequestMessages, type ModelView } from './model-view'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'
import type { FileChangeRecord, QueuedMessage } from '../../types/chat'
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentLlmDiagnostics,
} from './messages'
import type { AgentRunnableToolMap } from './tools'
import type { ReadFileState } from '../tools/types'

/** 轮次安全阀默认值：0 = 不限（照抄 dsh 无内置轮次预算）；>0 时超限优雅收尾。 */
const DEFAULT_MAX_TURNS = 0

/** 插话（steer）收件箱访问口：由 session 层注入，query 不持有状态所有权。 */
export type SteeringAccess = {
  /** 抽干 next-step 队列（claim 即消费，调用方负责状态更新与持久化） */
  drain(): QueuedMessage[]
  /** next-step 是否还有未抽干的插话（steer 续命判定） */
  hasPending(): boolean
}

export type AgentQueryEvent =
  | { type: 'query-step-start'; step: number }
  | { type: 'model-start'; step: number; debug?: ModelStartDebugInfo }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant-reasoning-delta'; text: string }
  | { type: 'model-finish'; step: number; toolCallCount: number; finishReason?: string; diagnostics?: AgentLlmDiagnostics }
  | { type: 'model-tool-call-parse-warning'; step: number; finishReason?: string; diagnostics?: AgentLlmDiagnostics }
  | { type: 'tool-batch-start'; step: number; toolCallCount: number }
  | { type: 'tool-batch-finish'; step: number; toolResultCount: number }
  | { type: 'context-compacted'; compactedMessageCount: number; originalTokens: number; summaryTokens: number }
  | { type: 'turn-limit-reached'; maxTurns: number }
  | { type: 'aborted'; reason: 'user'; partialContent?: string }
  | { type: 'assistant-message'; message: AgentAssistantMessage }
  /** 抽干点取到的插话消息（已追加进模型视图）；session 层据此 push 显示层气泡。 */
  | { type: 'steering-message'; message: QueuedMessage }
  | ToolExecutionEvent
  | { type: 'done'; messages: AgentMessage[]; aborted?: boolean }

export async function query(input: {
  config: ProjectConfig
  project: ProjectSnapshot
  /** 模型视图：query 循环直接在其上追加/压缩，视图是发给 LLM 消息序列的唯一来源。 */
  view: ModelView
  tools: AgentRunnableToolMap
  /** 轮次安全阀：0/undefined = 不限；显式传参仅测试用。 */
  maxTurns?: number
  signal?: AbortSignal
  /** 写工具确认回调，透传到工具执行层。 */
  confirm?: ConfirmHandler
  /** 插话收件箱访问口（steer）：每个 step 边界抽干，结局前非空则续命。 */
  steering?: SteeringAccess
  /** 会话改动账本只读取口（GetFileChangeHistory 用），透传到工具执行层。 */
  getChangeLedger?: () => readonly FileChangeRecord[]
  /** 联网搜索匿名身份（localStorage UUID，app 层注入），透传到工具运行时。 */
  webClientId?: string
  onEvent?: (event: AgentQueryEvent) => void
}): Promise<AgentMessage[]> {
  const view = input.view
  // 轮次上限可关闭的安全阀：config.settings.agentMaxTurns（默认 0=不限，照抄 dsh 无内置预算）
  const maxTurns = input.maxTurns ?? input.config.settings.agentMaxTurns ?? DEFAULT_MAX_TURNS
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

  // turn 层：while(true) 跑 step（照抄 dsh 分层循环；step 层 = 溢出重试 while(true)，保持不动）
  let step = 0
  while (true) {
    step += 1

    // 每一轮开始前检查用户是否已停止（工具执行完毕后停止的边界）
    if (input.signal?.aborted) {
      input.onEvent?.({ type: 'aborted', reason: 'user' })
      input.onEvent?.({ type: 'done', messages: view.messages, aborted: true })
      return view.messages
    }

    // ① 抽干点：先抽干（插话进模型视图）再压缩判定——顺序与 dsh 一致（claim 在前、压缩钩子在后）
    if (input.steering) {
      const claimed = input.steering.drain()
      for (const message of claimed) {
        appendUserMessage(view, buildSteeringContent(message))
        input.onEvent?.({ type: 'steering-message', message })
      }
    }

    // 压缩期用户停止：与流式中断同口径归类 aborted，绝不上抛成 run-error
    try {
      await compactIfOverThreshold()
    } catch (error) {
      if (error instanceof AgentAbortedError) {
        input.onEvent?.({ type: 'aborted', reason: 'user' })
        input.onEvent?.({ type: 'done', messages: view.messages, aborted: true })
        return view.messages
      }
      throw error
    }

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
            protocol: input.config.llm.protocol,
            messages,
            tools: availableTools.map((tool) => tool.schema),
            // 思考档位：default 档不传（provider 自决），其余四档下发到适配器映射
            ...(input.config.llm.reasoningEffort && input.config.llm.reasoningEffort !== 'default'
              ? { reasoningEffort: input.config.llm.reasoningEffort }
              : {}),
            signal: input.signal,
          },
          (event) => {
            // 流式 delta 向上透传（UI 实时渲染用）；最终完整文本仍由 assistant-message 事件落盘。
            if (event.type === 'delta') {
              input.onEvent?.({ type: 'assistant-delta', text: event.text })
            }
            // 思考流增量同链平行透传（思考先于正文，同一条 assistant 消息内）
            if (event.type === 'reasoning-delta') {
              input.onEvent?.({ type: 'assistant-reasoning-delta', text: event.text })
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
          let compactionResult: CompactionResult | null
          try {
            compactionResult = await runCompaction({ config: input.config, view, retainTokens, signal: input.signal })
          } catch (compactionError) {
            // 压缩期用户停止：归类 aborted；压缩摘要的半截内容不是用户内容，不落盘
            if (compactionError instanceof AgentAbortedError) {
              input.onEvent?.({ type: 'aborted', reason: 'user' })
              input.onEvent?.({ type: 'done', messages: view.messages, aborted: true })
              return view.messages
            }
            throw compactionError
          }
          if (compactionResult) {
            input.onEvent?.({ type: 'context-compacted', ...compactionResult })
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
      ...(assistantResponse.reasoning ? { reasoning: assistantResponse.reasoning } : {}),
      ...(assistantResponse.thinkingSignature ? { thinkingSignature: assistantResponse.thinkingSignature } : {}),
      toolCalls: assistantResponse.toolCalls,
    }

    appendAssistantMessage(view, assistantMessage)
    input.onEvent?.({ type: 'assistant-message', message: assistantMessage })

    if (assistantResponse.toolCalls.length === 0) {
      // steer 续命：结局已定但插话队列非空 → turn 不闭合，继续 loop（下一抽干点整批取到）
      if (input.steering?.hasPending()) {
        continue
      }
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
      getChangeLedger: input.getChangeLedger,
      webClientId: input.webClientId,
      onEvent: input.onEvent,
    })

    input.onEvent?.({
      type: 'tool-batch-finish',
      step,
      toolResultCount: toolResults.length,
    })

    appendToolResults(view, toolResults)

    // 轮次安全阀：0 = 不限；>0 且达到上限时优雅收尾——发事件告知用户，
    // 模型视图原样保留（末尾停在最后的工具结果，序列合法），用户继续发消息即可续接。
    if (maxTurns > 0 && step >= maxTurns) {
      input.onEvent?.({ type: 'turn-limit-reached', maxTurns })
      input.onEvent?.({ type: 'done', messages: view.messages })
      return view.messages
    }
  }
}

/** 插话消息进模型视图的包装：标注「执行中插话」，模型据此优先响应最新意图。session 层 turn 首批与 query 抽干点共用。 */
export function buildSteeringContent(message: QueuedMessage): string {
  const lines = [`用户插话（任务执行中发送，优先响应最新意图）：${message.text}`]
  if (message.quote?.trim()) {
    lines.push('', '用户引用的内容：', message.quote.trim())
  }
  return lines.join('\n')
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
