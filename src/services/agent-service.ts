import {
  createChatSession,
  runChatTurn,
} from '../core/chat/session'
import { deriveChatTargetFromPath } from '../core/chat/target'
import { readSystemPrompt } from '../core/fs/project-fs'
import type { AgentMessage, AgentToolCall } from '../core/agent/messages'
import type { ChatMessage, ChatSessionState, ChatTargetContext } from '../types/chat'

import {
  requireRuntimeProject,
} from './project-runtime'
import type {
  AgentUiEvent,
  ChangedFileView,
  ChatMessageView,
  ChatSessionView,
  ChatTargetView,
  NovAiError,
  RunAgentTurnInput,
  RunAgentTurnResult,
  ToolCallView,
  ToolNameView,
  ToolResultView,
} from './types'

const sessionMap = new Map<string, ChatSessionState>()

export function deriveTargetFromPath(path?: string | null): ChatTargetView | null {
  return toChatTargetView(deriveChatTargetFromPath(path))
}

export async function createSession(projectId: string): Promise<ChatSessionView> {
  requireRuntimeProject(projectId)

  const session = createChatSession(projectId)
  sessionMap.set(projectId, session)

  return toChatSessionView(session)
}

export async function getSession(projectId: string): Promise<ChatSessionView | null> {
  const session = sessionMap.get(projectId)
  return session ? toChatSessionView(session) : null
}

export async function runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const project = requireRuntimeProject(input.projectId)
  const previousSession = input.sessionId
    ? findSessionById(input.projectId, input.sessionId) ?? createChatSession(input.projectId)
    : sessionMap.get(input.projectId) ?? createChatSession(input.projectId)
  const runId = createRunId()

  sessionMap.set(input.projectId, previousSession)
  input.onEvent?.({
    type: 'run-start',
    runId,
    sessionId: previousSession.sessionId,
  })

  try {
    const systemPrompt = await readSystemPrompt(project.handle)
    let previousDraftText = ''
    const turn = await runChatTurn({
      session: previousSession,
      input: {
        instruction: input.instruction,
        project,
        config: project.config,
        systemPrompt,
        activeFilePath: input.activeFilePath,
      },
      onEvent(event) {
        if (event.type === 'draft') {
          const deltaText = event.text.startsWith(previousDraftText)
            ? event.text.slice(previousDraftText.length)
            : event.text
          previousDraftText = event.text

          input.onEvent?.({
            type: 'assistant-delta',
            text: deltaText,
            fullText: event.text,
          })
          return
        }

        emitMessageEvent(event.message, input.onEvent)
      },
    })

    sessionMap.set(input.projectId, turn.session)

    const changedFiles = collectChangedFiles(turn.session)
    const result: RunAgentTurnResult = {
      projectId: input.projectId,
      sessionId: turn.session.sessionId,
      targetPath: turn.target?.primaryPath,
      changedFiles,
      session: toChatSessionView(turn.session, changedFiles[changedFiles.length - 1]),
    }

    for (const file of changedFiles) {
      input.onEvent?.({ type: 'file-changed', file })
    }

    input.onEvent?.({ type: 'run-finish', result })
    return result
  } catch (error) {
    const serviceError = toNovAiError(error)
    input.onEvent?.({ type: 'run-error', error: serviceError })
    throw error
  }
}

function findSessionById(projectId: string, sessionId: string) {
  const session = sessionMap.get(projectId)
  return session?.sessionId === sessionId ? session : null
}

function emitMessageEvent(
  message: ChatMessage,
  onEvent?: (event: AgentUiEvent) => void,
) {
  const view = toChatMessageView(message)
  onEvent?.({ type: 'message', message: view })

  if (message.kind === 'tool-call') {
    onEvent?.({
      type: 'tool-call',
      toolCall: {
        id: message.id,
        name: message.toolName,
        inputSummary: message.inputSummary,
        createdAt: message.createdAt,
      },
    })
  }

  if (message.kind === 'tool-result') {
    onEvent?.({
      type: 'tool-result',
      toolResult: {
        callId: message.id,
        name: message.toolName,
        ok: message.ok,
        resultSummary: message.resultSummary,
        error: message.ok ? undefined : {
          code: 'TOOL_EXECUTION_FAILED',
          message: message.resultSummary,
          recoverable: true,
        },
        createdAt: message.createdAt,
      },
    })
  }
}

function toChatSessionView(
  session: ChatSessionState,
  lastChangedFile?: ChangedFileView,
): ChatSessionView {
  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    status: session.status,
    messages: session.messages.map(toChatMessageView),
    currentDraftText: session.currentDraftText,
    currentTargetPath: session.currentTarget?.primaryPath,
    lastChangedFile,
  }
}

function toChatMessageView(message: ChatMessage): ChatMessageView {
  if (message.kind === 'text') {
    return {
      id: message.id,
      role: message.role,
      kind: 'text',
      text: message.text,
      createdAt: message.createdAt,
    }
  }

  if (message.kind === 'action-summary') {
    return {
      id: message.id,
      role: 'assistant',
      kind: 'action-summary',
      text: message.summary,
      targetPath: message.targetPath,
      relatedPaths: message.relatedPaths,
      createdAt: message.createdAt,
    }
  }

  if (message.kind === 'tool-call') {
    return {
      id: message.id,
      role: 'system',
      kind: 'tool-call',
      text: message.inputSummary,
      toolName: message.toolName,
      createdAt: message.createdAt,
    }
  }

  if (message.kind === 'tool-result') {
    return {
      id: message.id,
      role: 'system',
      kind: 'tool-result',
      text: message.resultSummary,
      ok: message.ok,
      toolName: message.toolName,
      createdAt: message.createdAt,
    }
  }

  if (message.kind === 'context-summary') {
    return {
      id: message.id,
      role: 'system',
      kind: 'context-summary',
      text: message.summary,
      createdAt: message.createdAt,
    }
  }

  return {
    id: message.id,
    role: 'system',
    kind: 'error',
    text: message.message,
    createdAt: message.createdAt,
  }
}

function collectChangedFiles(session: ChatSessionState): ChangedFileView[] {
  const changes: ChangedFileView[] = []
  const toolResultTextById = collectToolResultTextById(session.agentMessages ?? [])

  for (const message of session.agentMessages ?? []) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      continue
    }

    for (const call of message.toolCalls) {
      const resultText = toolResultTextById.get(call.id) ?? ''
      const change = toChangedFile(call, resultText)

      if (change) {
        changes.push(change)
      }
    }
  }

  return dedupeChangedFiles(changes)
}

function collectToolResultTextById(messages: AgentMessage[]) {
  const result = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'tool') {
      result.set(message.toolCallId, message.content)
    }
  }

  return result
}

function toChangedFile(
  call: AgentToolCall,
  resultText: string,
): ChangedFileView | null {
  if (!isSuccessfulToolResult(resultText)) {
    return null
  }

  if (call.name === 'CreateFile' && typeof call.input.path === 'string') {
    return {
      type: 'created',
      path: call.input.path,
    }
  }

  if (call.name === 'EditFile' && typeof call.input.path === 'string') {
    return {
      type: 'updated',
      path: call.input.path,
    }
  }

  if (
    call.name === 'RenameFile' &&
    typeof call.input.fromPath === 'string' &&
    typeof call.input.toPath === 'string'
  ) {
    return {
      type: 'renamed',
      fromPath: call.input.fromPath,
      toPath: call.input.toPath,
    }
  }

  if (call.name === 'DeleteFile' && typeof call.input.path === 'string') {
    return {
      type: 'deleted',
      path: call.input.path,
      trashPath: extractTrashPath(resultText),
    }
  }

  return null
}

function isSuccessfulToolResult(resultText: string) {
  return /^(已读取|已修改|已新建|已将|已查看|已在)/.test(resultText)
}

function extractTrashPath(resultText: string) {
  const match = resultText.match(/移入回收站\s+([^，\s]+)/)
  return match?.[1]
}

function dedupeChangedFiles(changes: ChangedFileView[]) {
  const seen = new Set<string>()
  const output: ChangedFileView[] = []

  for (const change of changes) {
    const key = JSON.stringify(change)

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    output.push(change)
  }

  return output
}

function toNovAiError(error: unknown): NovAiError {
  return {
    code: 'UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : 'Agent 执行失败',
    recoverable: true,
    detail: error,
  }
}

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function toChatTargetView(target: ChatTargetContext | null): ChatTargetView | null {
  if (!target) {
    return null
  }

  return {
    type: target.type,
    primaryPath: target.primaryPath,
    groupName: target.groupName,
    displayName: target.displayName,
    derivedFrom: target.derivedFrom === 'explicit-user-intent'
      ? 'instruction'
      : target.derivedFrom,
  }
}
