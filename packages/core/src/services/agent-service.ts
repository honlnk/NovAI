import {
  createChatSession,
  runChatTurn,
} from '../core/chat/session'
import { deriveChatTargetFromPath } from '../core/chat/target'
import { readScenePrompt, readSystemPrompt } from '../core/fs/project-fs'
import type { FileChange } from '../core/tools/types'
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
    const scenePrompt = await readScenePrompt(
      project.handle,
      project.config.settings.activeScenePromptPath,
    )
    const turn = await runChatTurn({
      session: previousSession,
      input: {
        instruction: input.instruction,
        quote: input.quote,
        project,
        config: project.config,
        systemPrompt,
        scenePrompt,
        activeFilePath: input.activeFilePath,
        signal: input.signal,
      },
      onEvent(event) {
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
      // 仅 user text 消息有 quote；assistant text 无此字段，undefined 自动忽略
      quote: 'quote' in message ? message.quote : undefined,
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

  for (const message of session.agentMessages ?? []) {
    if (message.role !== 'tool') {
      continue
    }

    // fileChange 由 tool-execution 在写工具成功执行后从 output 提取并挂载，
    // 是结构化、可信的文件变更来源，不再依赖工具结果文本反推。
    const change = message.fileChange
    if (change) {
      changes.push(toChangedFileView(change))
    }
  }

  return dedupeChangedFiles(changes)
}

function toChangedFileView(change: FileChange): ChangedFileView {
  // core 的 FileChange 与 service 的 ChangedFileView 形状一致；
  // 显式映射而非直接透传，避免 service 层依赖 core 工具内部类型的结构。
  if (change.type === 'renamed') {
    return { type: 'renamed', fromPath: change.fromPath, toPath: change.toPath }
  }

  if (change.type === 'deleted') {
    return { type: 'deleted', path: change.path, trashPath: change.trashPath }
  }

  return { type: change.type, path: change.path }
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
