import { buildAgentSystemPrompt, buildAgentUserContext } from '../agent/prompt'
import { query } from '../agent/query'
import { createAgentTools } from '../agent/tools'
import {
  appendUserMessage,
  createModelView,
  setSystemMessage,
  toRequestMessages,
} from '../agent/model-view'
import { createLogId, writeAgentLog } from '../logging/agent-log'
import { hashContent } from '../util/hash'
import type { AgentQueryEvent } from '../agent/query'

import { deriveChatTargetFromPath } from './target'

import type {
  ChatMessage,
  ChatSessionState,
  ChatTargetContext,
  ChatTurnInput,
  ChatTurnResult,
} from '../../types/chat'
import type { AgentMessage } from '../agent/messages'
import type { FileChange } from '../tools/types'

type SessionEvent =
  | { type: 'message'; message: ChatMessage }
  /** 模型流式输出的文本增量（瞬态渲染态，不落盘）；同一条 assistant 消息共享稳定 messageId。 */
  | { type: 'message-delta'; messageId: string; text: string }

type RunChatTurnOptions = {
  session: ChatSessionState
  input: ChatTurnInput
  onEvent?: (event: SessionEvent) => void
}

export function createChatSession(projectId: string): ChatSessionState {
  const now = new Date().toISOString()
  return {
    sessionId: createId('session'),
    projectId,
    messages: [],
    modelView: createModelView(),
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    title: DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
  }
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { input, onEvent } = options
  const session: ChatSessionState = {
    ...options.session,
    status: 'running',
    lastWrittenPath: undefined,
  }

  const target = deriveChatTargetFromPath(input.activeFilePath)
  session.currentTarget = target
  const runId = createLogId('run')

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_start',
    message: 'Agent 开始处理用户输入',
    data: {
      instruction: input.instruction,
      quote: input.quote,
      activeFilePath: input.activeFilePath,
      target,
    },
  })

  pushMessage(session, createUserMessage(input.instruction, input.quote), onEvent)
  pushMessage(session, createContextSummary(target), onEvent)
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'context-summary',
      summary: '本轮任务类型：Agent Loop，由模型根据上下文自主决定是否读写文件',
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  // 模型视图：发给 LLM 的消息序列唯一来源。与显示层 messages 彻底分离——
  // 显示层是全量 transcript（持久化 + UI），模型层持久化的是压缩后的当前视图。
  // 拷贝建视图，本回合的变更不污染传入的会话对象。
  const modelView = createModelView(session.modelView?.messages ?? [])
  session.modelView = modelView

  // 同会话内 system.md 或场景提示词变化时，刷新视图里的 system message（恒在 index 0）。
  const newSystemContent = buildAgentSystemPrompt({
    systemPrompt: input.systemPrompt,
    scenePrompt: input.scenePrompt,
    novaiOverview: input.novaiOverview,
  })
  const newSystemHash = hashContent(newSystemContent)
  if (modelView.messages.length === 0 || session.systemPromptHash !== newSystemHash) {
    setSystemMessage(modelView, newSystemContent)
  }
  session.systemPromptHash = newSystemHash

  appendUserMessage(modelView, buildAgentUserContext({
    instruction: input.instruction,
    quote: input.quote,
    project: input.project,
    target,
  }))
  const requestMessages = toRequestMessages(modelView)
  const tools = createAgentTools()
  const enableDebugLogging = Boolean(input.config.settings.enableDebugLogging)
  let aborted = false
  // 当前正在流式输出的 assistant 消息 id：delta 事件携带它，最终的 assistant 落盘消息复用它，
  // 让 UI 能把连续 delta 累积到同一条气泡上、并用完成事件原位替换。
  let streamingMessageId: string | null = null

  if (enableDebugLogging) {
    void writeAgentLog(input.project, {
      sessionId: session.sessionId,
      runId,
      level: 'debug',
      event: 'agent_messages_debug',
      message: 'Agent 模型输入消息调试信息',
      data: {
        messageCount: requestMessages.length,
        messages: summarizeAgentMessages(requestMessages),
      },
    })
  }

  try {
    await query({
      config: input.config,
      project: input.project,
      view: modelView,
      tools,
      signal: input.signal,
      confirm: input.confirm,
      onEvent(event) {
        logAgentQueryEvent({
          project: input.project,
          session,
          runId,
          event,
        })

        if (event.type === 'aborted') {
          aborted = true
          void writeAgentLog(input.project, {
            sessionId: session.sessionId,
            runId,
            level: 'info',
            event: 'agent_run_aborted',
            message: 'Agent 被用户停止',
          })
          return
        }

        if (event.type === 'turn-limit-reached') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'context-summary',
              summary: `本轮 Agent 已达最大循环次数（${event.maxTurns}），先停在这里。上下文已保留，继续发送消息即可让它接着完成。`,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'context-compacted') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'context-summary',
              summary: `已自动压缩 ${event.compactedMessageCount} 条早期消息（约 ${event.originalTokens} → ${event.summaryTokens} token），此前对话以检查点摘要继续`,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'assistant-delta') {
          streamingMessageId ??= createId('message')
          onEvent?.({ type: 'message-delta', messageId: streamingMessageId, text: event.text })
          return
        }

        if (event.type === 'assistant-message') {
          if (event.message.content.trim()) {
            pushMessage(
              session,
              createAssistantText(event.message.content.trim(), streamingMessageId ?? undefined),
              onEvent,
            )
          }
          // 本条 assistant 消息完结（无论是否有正文），下一条流式文本属于新气泡
          streamingMessageId = null
          return
        }

        if (event.type === 'tool-call') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'tool-call',
              toolName: event.call.name,
              inputSummary: event.inputSummary,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'tool-result') {
          // lastWrittenPath 取结构化 fileChange 的目标路径，不再从 input 猜。
          if (event.ok && event.fileChange) {
            session.lastWrittenPath = resolveWrittenPath(event.fileChange)
          }

          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'tool-result',
              toolName: event.call.name,
              ok: event.ok,
              resultSummary: event.resultSummary,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
        }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型生成失败'
    session.status = 'error'
    void writeAgentLog(input.project, {
      sessionId: session.sessionId,
      runId,
      level: 'error',
      event: 'agent_run_error',
      message,
    })
    pushErrorMessage(session, message, true, onEvent)
    throw error
  }

  if (aborted) {
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'assistant',
        kind: 'action-summary',
        summary: session.lastWrittenPath
          ? `本轮 Agent 已被停止，停止前已写回 ${session.lastWrittenPath}`
          : '本轮 Agent 已被用户停止。',
        targetPath: session.lastWrittenPath,
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )

    session.status = 'waiting-user'

    return {
      session,
      target,
      writtenPath: session.lastWrittenPath,
    }
  }

  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'assistant',
      kind: 'action-summary',
      summary: session.lastWrittenPath
        ? `本轮 Agent Loop 完成，已写回 ${session.lastWrittenPath}`
        : '本轮 Agent Loop 完成，未写入文件。',
      targetPath: session.lastWrittenPath,
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  session.status = 'waiting-user'

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_finish',
    message: session.lastWrittenPath
      ? `Agent 本轮完成并写回 ${session.lastWrittenPath}`
      : 'Agent 本轮完成，未写入文件',
    data: {
      writtenPath: session.lastWrittenPath,
      agentMessageCount: session.modelView?.messages.length ?? 0,
    },
  })

  return {
    session,
    target,
    writtenPath: session.lastWrittenPath,
  }
}

function logAgentQueryEvent(input: {
  project: ChatTurnInput['project']
  session: ChatSessionState
  runId: string
  event: AgentQueryEvent
}) {
  const base = {
    sessionId: input.session.sessionId,
    runId: input.runId,
  }

  if (input.event.type === 'query-step-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'query_step_start',
      message: `Query Step ${input.event.step} 开始`,
      data: { step: input.event.step },
    })
    return
  }

  if (input.event.type === 'model-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'model_start',
      message: `第 ${input.event.step} 轮模型调用开始`,
      data: input.event.debug
        ? {
          step: input.event.step,
          ...input.event.debug,
        }
        : { step: input.event.step },
    })
    return
  }

  if (input.event.type === 'model-finish') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'model_finish',
      message: `第 ${input.event.step} 轮模型调用结束，返回 ${input.event.toolCallCount} 个工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'model-tool-call-parse-warning') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'warn',
      event: 'model_tool_call_parse_warning',
      message: `第 ${input.event.step} 轮模型以 tool_calls 结束，但没有解析出有效工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'assistant-message') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'assistant_message',
      message: input.event.message.toolCalls?.length
        ? `Assistant 返回文本并请求 ${input.event.message.toolCalls.length} 个工具调用`
        : 'Assistant 返回文本',
      data: {
        content: input.event.message.content,
        toolCalls: input.event.message.toolCalls,
      },
    })
    return
  }

  if (input.event.type === 'turn-limit-reached') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'warn',
      event: 'turn_limit_reached',
      message: `已达 Agent 单轮最大循环次数（${input.event.maxTurns}），优雅收尾`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'context-compacted') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'context_compacted',
      message: `上下文已压缩：${input.event.compactedMessageCount} 条消息浓缩为检查点（${input.event.originalTokens} → ${input.event.summaryTokens} token）`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'tool-batch-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_batch_start',
      message: `第 ${input.event.step} 轮开始执行 ${input.event.toolCallCount} 个工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'tool-call') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_call',
      message: input.event.inputSummary,
      data: {
        id: input.event.call.id,
        name: input.event.call.name,
        input: input.event.call.input,
      },
    })
    return
  }

  if (input.event.type === 'tool-result') {
    void writeAgentLog(input.project, {
      ...base,
      level: input.event.ok ? 'info' : 'error',
      event: 'tool_result',
      message: input.event.resultSummary,
      data: {
        id: input.event.call.id,
        name: input.event.call.name,
        ok: input.event.ok,
      },
    })
    return
  }

  if (input.event.type === 'tool-batch-finish') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_batch_finish',
      message: `第 ${input.event.step} 轮工具执行结束`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'done') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'query_done',
      message: 'Query Loop 完成',
      data: {
        messageCount: input.event.messages.length,
      },
    })
  }
}

function summarizeAgentMessages(messages: AgentMessage[]) {
  return messages.map((message, index) => {
    if (message.role === 'assistant') {
      return {
        index,
        role: message.role,
        contentLength: message.content.length,
        contentPreview: previewLogText(message.content),
        toolCallCount: message.toolCalls?.length ?? 0,
        toolCalls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })),
      }
    }

    if (message.role === 'tool') {
      return {
        index,
        role: message.role,
        toolCallId: message.toolCallId,
        name: message.name,
        contentLength: message.content.length,
        contentPreview: previewLogText(message.content),
      }
    }

    return {
      index,
      role: message.role,
      contentLength: message.content.length,
      contentPreview: previewLogText(message.content),
    }
  })
}

function previewLogText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized
}

function pushMessage(
  session: ChatSessionState,
  message: ChatMessage,
  onEvent?: (event: SessionEvent) => void,
) {
  session.messages = [...session.messages, message]
  onEvent?.({ type: 'message', message })
}

function pushErrorMessage(
  session: ChatSessionState,
  message: string,
  recoverable: boolean,
  onEvent?: (event: SessionEvent) => void,
) {
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'error',
      message,
      recoverable,
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )
}

function createUserMessage(text: string, quote?: string): ChatMessage {
  return {
    id: createId('message'),
    role: 'user',
    kind: 'text',
    text,
    quote,
    createdAt: new Date().toISOString(),
  }
}

function createAssistantText(text: string, id?: string): ChatMessage {
  return {
    id: id ?? createId('message'),
    role: 'assistant',
    kind: 'text',
    text,
    createdAt: new Date().toISOString(),
  }
}

function createContextSummary(target: ChatTargetContext | null): ChatMessage {
  return {
    id: createId('message'),
    role: 'system',
    kind: 'context-summary',
    summary: target?.primaryPath
      ? `本轮默认目标：${target.displayName}（${target.primaryPath}）`
      : '本轮默认目标：当前项目，将生成新的章节草稿',
    createdAt: new Date().toISOString(),
  }
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// 从结构化 fileChange 取最终落点：rename 取 toPath，其余取 path。
function resolveWrittenPath(change: FileChange): string {
  return change.type === 'renamed' ? change.toPath : change.path
}

/** 新会话默认标题，首轮用户消息后会被首句截断覆盖 */
export const DEFAULT_SESSION_TITLE = '新对话'

/** 首句截断上限（字符），用于从首条用户消息生成会话标题 */
const SESSION_TITLE_MAX_LENGTH = 20

/**
 * 从首条用户消息派生会话标题：取首行、压空白、超长截断加省略号。
 * 用于新建会话首轮发送后自动更新标题，避免列表里全是「新对话」。
 */
export function deriveSessionTitle(firstUserText: string): string {
  const firstLine = firstUserText.split(/\r?\n/)[0] ?? firstUserText
  const normalized = firstLine.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return DEFAULT_SESSION_TITLE
  }
  return normalized.length > SESSION_TITLE_MAX_LENGTH
    ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH)}…`
    : normalized
}
