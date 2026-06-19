import { buildAgentSystemPrompt, buildAgentUserContext } from '../agent/prompt'
import { query } from '../agent/query'
import { createAgentTools } from '../agent/tools'
import { createLogId, writeAgentLog } from '../logging/agent-log'
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

type RunChatTurnOptions = {
  session: ChatSessionState
  input: ChatTurnInput
  onEvent?: (event: SessionEvent) => void
}

export function createChatSession(projectId: string): ChatSessionState {
  return {
    sessionId: createId('session'),
    projectId,
    messages: [],
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
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

  const agentMessages = buildAgentMessages({
    previousMessages: session.agentMessages,
    instruction: input.instruction,
    quote: input.quote,
    systemPrompt: input.systemPrompt,
    scenePrompt: input.scenePrompt,
    project: input.project,
    target,
  })
  const tools = createAgentTools()
  const enableDebugLogging = Boolean(input.config.settings.enableDebugLogging)
  let aborted = false

  if (enableDebugLogging) {
    void writeAgentLog(input.project, {
      sessionId: session.sessionId,
      runId,
      level: 'debug',
      event: 'agent_messages_debug',
      message: 'Agent 模型输入消息调试信息',
      data: {
        messageCount: agentMessages.length,
        messages: summarizeAgentMessages(agentMessages),
      },
    })
  }

  try {
    session.agentMessages = await query({
      config: input.config,
      project: input.project,
      messages: agentMessages,
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

        if (event.type === 'assistant-message') {
          if (event.message.content.trim()) {
            pushMessage(session, createAssistantText(event.message.content.trim()), onEvent)
          }
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
      agentMessageCount: session.agentMessages?.length ?? 0,
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

function buildAgentMessages(input: {
  previousMessages?: AgentMessage[]
  instruction: string
  quote?: string
  systemPrompt: string
  scenePrompt?: string
  project: ChatTurnInput['project']
  target: ChatTargetContext | null
}): AgentMessage[] {
  const nextUserMessage: AgentMessage = {
    role: 'user',
    content: buildAgentUserContext({
      instruction: input.instruction,
      quote: input.quote,
      project: input.project,
      target: input.target,
    }),
  }

  if (input.previousMessages?.length) {
    return [...input.previousMessages, nextUserMessage]
  }

  return [
    {
      role: 'system',
      content: buildAgentSystemPrompt({
        systemPrompt: input.systemPrompt,
        scenePrompt: input.scenePrompt,
      }),
    },
    nextUserMessage,
  ]
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

function createAssistantText(text: string): ChatMessage {
  return {
    id: createId('message'),
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
