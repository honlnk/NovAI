import {
  createChatSession,
  runChatTurn,
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
} from '../core/chat/session'
import {
  saveSession,
  loadSession,
  deleteSessionFile,
  listSessionMetas,
} from '../core/chat/session-store'
import { deriveChatTargetFromPath } from '../core/chat/target'
import { readScenePrompt, readSystemPrompt } from '../core/fs/project-fs'
import type { ConfirmHandler } from '../core/agent/tool-execution'
import { parseToolPolicy } from '../core/agent/tool-policy'
import type { FileChange, WriteConfirmation } from '../core/tools/types'
import type { ChatMessage, ChatSessionState, ChatTargetContext } from '../types/chat'

import {
  requireRuntimeProject,
} from './project-runtime'
import type {
  AgentUiEvent,
  ChangedFileView,
  ChatMessageView,
  ChatSessionSummaryView,
  ChatSessionView,
  ChatTargetView,
  FileChangeConfirmationView,
  NovAiError,
  RunAgentTurnInput,
  RunAgentTurnResult,
  ToolCallView,
  ToolNameView,
  ToolResultView,
  WriteConfirmationView,
} from './types'

/**
 * 会话内存态：key 为 sessionId（一个项目可同时驻留多个历史会话）。
 * 从「单项目单会话」升级为「多会话」，支持历史会话切换。
 */
const sessionMap = new Map<string, ChatSessionState>()

// 确认注册表：confirmationId -> resolve。UI 调 respondConfirmation 时取出来 resolve，
// 唤醒在 confirm 回调里 await 的 Agent Loop。
type PendingConfirmation = {
  projectId: string
  resolve: (decision: { accepted: boolean }) => void
}
const confirmationMap = new Map<string, PendingConfirmation>()

/** 每个项目当前激活的会话 id；新建/切换/删除时维护。 */
const activeSessionByProject = new Map<string, string>()

export function deriveTargetFromPath(path?: string | null): ChatTargetView | null {
  return toChatTargetView(deriveChatTargetFromPath(path))
}

export async function createSession(projectId: string): Promise<ChatSessionView> {
  const project = requireRuntimeProject(projectId)

  const session = createChatSession(projectId)
  sessionMap.set(session.sessionId, session)
  activeSessionByProject.set(projectId, session.sessionId)

  // 新建即落盘，确保列表能立即看到（即便用户还没发消息）
  await saveSession(project, session)

  return toChatSessionView(session)
}

/**
 * 取会话视图。sessionId 缺省时返回该项目当前激活会话。
 * 内存未命中时从文件系统加载并缓存，支持「冷启动后查看历史会话」。
 */
export async function getSession(
  projectId: string,
  sessionId?: string,
): Promise<ChatSessionView | null> {
  const targetId = sessionId ?? activeSessionByProject.get(projectId)
  if (!targetId) {
    return null
  }

  const session = await resolveSession(projectId, targetId)
  if (!session) {
    return null
  }

  // 若传了 sessionId 且与当前激活不同，则切换激活
  if (sessionId && activeSessionByProject.get(projectId) !== sessionId) {
    activeSessionByProject.set(projectId, sessionId)
  }

  return toChatSessionView(session)
}

/** 列出项目下所有历史会话摘要（按 updatedAt 降序）。 */
export async function listSessions(
  projectId: string,
): Promise<ChatSessionSummaryView[]> {
  const project = requireRuntimeProject(projectId)
  const metas = await listSessionMetas(project)

  return metas.map((meta) => ({
    sessionId: meta.sessionId,
    projectId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
  }))
}

/** 重命名会话标题（只改 state.title，不动文件名）。返回更新后的视图。 */
export async function renameSession(
  projectId: string,
  sessionId: string,
  title: string,
): Promise<ChatSessionView> {
  const project = requireRuntimeProject(projectId)
  const session = await resolveSession(projectId, sessionId)
  if (!session) {
    throw new Error(`会话不存在或已删除：${sessionId}`)
  }

  session.title = title.trim() || DEFAULT_SESSION_TITLE
  await saveSession(project, session)

  return toChatSessionView(session)
}

/** 删除会话：删文件 + 移出内存；若删的是激活会话则激活置空（由前端决定后续切到哪条）。 */
export async function deleteSession(projectId: string, sessionId: string): Promise<void> {
  const project = requireRuntimeProject(projectId)

  await deleteSessionFile(project, sessionId)
  sessionMap.delete(sessionId)

  if (activeSessionByProject.get(projectId) === sessionId) {
    activeSessionByProject.delete(projectId)
  }
}

/**
 * 取会话状态：内存优先，未命中则从盘读入并缓存。
 * 这是 sessionMap 多会话化后的统一读取入口。
 */
async function resolveSession(
  projectId: string,
  sessionId: string,
): Promise<ChatSessionState | null> {
  const cached = sessionMap.get(sessionId)
  if (cached) {
    return cached
  }

  const project = requireRuntimeProject(projectId)
  const loaded = await loadSession(project, sessionId)
  if (!loaded) {
    return null
  }

  sessionMap.set(sessionId, loaded)
  return loaded
}

export async function runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const project = requireRuntimeProject(input.projectId)

  // 按 sessionId 路由到对应历史会话；都没有则新建（并落盘）。
  const resolved = input.sessionId
    ? await resolveSession(input.projectId, input.sessionId)
    : null
  const previousSession = resolved
    ?? await resolveActiveOrCreate(input.projectId)
  const runId = createRunId()

  // 记录首轮发送前的状态，用于判断本轮是否为「首条用户消息」以自动生成标题
  const hadNoUserMessage = !previousSession.messages.some((m) => m.role === 'user')
  const titleBeforeTurn = previousSession.title

  sessionMap.set(previousSession.sessionId, previousSession)
  activeSessionByProject.set(input.projectId, previousSession.sessionId)
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
    // 写工具确认回调：构造预览 → 发 confirmation-required 事件 → 等 UI 调 respondConfirmation。
    const confirm: ConfirmHandler | undefined = input.onEvent
      ? (request) => requestConfirmation(input.projectId, request, input.onEvent!)
      : undefined
    // 用户即时工具约束：从 instruction 解析（如「不要读文件」「别改」「只读不改」「只改当前文件」），执行层强制禁用。
    // 路径约束需结合当前活动文件解析，activeFilePath 无值时降级为禁写。
    const toolPolicy = parseToolPolicy(input.instruction, input.activeFilePath)
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
        confirm,
        toolPolicy,
      },
      onEvent(event) {
        emitMessageEvent(event.message, input.onEvent)
      },
    })

    // 首轮用户消息后，若标题仍是默认值则用首句截断自动更新
    if (hadNoUserMessage && titleBeforeTurn === DEFAULT_SESSION_TITLE) {
      turn.session.title = deriveSessionTitle(input.instruction)
    }

    sessionMap.set(turn.session.sessionId, turn.session)
    // 每轮结束落盘，刷新 updatedAt，保证历史列表排序与内容持久
    await saveSession(project, turn.session)

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
    // 出错时清理未决确认，避免注册表泄漏 / UI 卡在等待态。
    rejectPendingConfirmations(input.projectId)
    const serviceError = toNovAiError(error)
    input.onEvent?.({ type: 'run-error', error: serviceError })
    throw error
  }
}

/**
 * 取当前激活会话；没有激活则新建并落盘。runTurn 在未显式传 sessionId 时走此路径。
 */
async function resolveActiveOrCreate(projectId: string): Promise<ChatSessionState> {
  const activeId = activeSessionByProject.get(projectId)
  if (activeId) {
    const cached = await resolveSession(projectId, activeId)
    if (cached) {
      return cached
    }
  }

  const project = requireRuntimeProject(projectId)
  const session = createChatSession(projectId)
  sessionMap.set(session.sessionId, session)
  activeSessionByProject.set(projectId, session.sessionId)
  await saveSession(project, session)
  return session
}

/**
 * 构造一次写工具确认：发 confirmation-required 事件，返回 Promise 等待 respondConfirmation。
 * Agent Loop 在 confirm 回调里 await 它，从而在用户决定前暂停。
 */
function requestConfirmation(
  projectId: string,
  request: { call: { id: string; name: ToolNameView }; confirmation: WriteConfirmation },
  onEvent: (event: AgentUiEvent) => void,
): Promise<{ accepted: boolean }> {
  const confirmationId = createRunId()
  const view: FileChangeConfirmationView = {
    id: confirmationId,
    toolName: request.call.name,
    title: buildConfirmationTitle(request.confirmation),
    summary: buildConfirmationSummary(request.confirmation),
    confirmation: toWriteConfirmationView(request.confirmation),
  }

  onEvent({ type: 'confirmation-required', request: view })

  return new Promise<{ accepted: boolean }>((resolve) => {
    confirmationMap.set(confirmationId, { projectId, resolve })
  })
}

/** UI 调用：响应对某次写工具确认的接受/拒绝，唤醒等待中的 Agent Loop。 */
export function respondConfirmation(confirmationId: string, accepted: boolean) {
  const pending = confirmationMap.get(confirmationId)
  if (!pending) {
    return
  }
  confirmationMap.delete(confirmationId)
  pending.resolve({ accepted })
}

/** 清理某项目的全部未决确认，按拒绝 resolve（出错/停止时调用）。 */
function rejectPendingConfirmations(projectId: string) {
  for (const [id, pending] of confirmationMap) {
    if (pending.projectId === projectId) {
      confirmationMap.delete(id)
      pending.resolve({ accepted: false })
    }
  }
}

function toWriteConfirmationView(confirmation: WriteConfirmation): WriteConfirmationView {
  switch (confirmation.kind) {
    case 'create':
      return { kind: 'create', path: confirmation.path, content: confirmation.content }
    case 'edit':
      return { kind: 'edit', path: confirmation.path, oldText: confirmation.oldText, newText: confirmation.newText }
    case 'rename':
      return { kind: 'rename', fromPath: confirmation.fromPath, toPath: confirmation.toPath }
    case 'delete':
      return { kind: 'delete', path: confirmation.path }
  }
}

function buildConfirmationTitle(confirmation: WriteConfirmation): string {
  switch (confirmation.kind) {
    case 'create':
      return `新建文件：${confirmation.path}`
    case 'edit':
      return `修改文件：${confirmation.path}`
    case 'rename':
      return `重命名：${confirmation.fromPath} → ${confirmation.toPath}`
    case 'delete':
      return `删除文件：${confirmation.path}`
  }
}

function buildConfirmationSummary(confirmation: WriteConfirmation): string {
  switch (confirmation.kind) {
    case 'create':
      return `将新建 ${confirmation.path}（${confirmation.content.length} 字符）`
    case 'edit':
      return `将修改 ${confirmation.path}（替换 ${confirmation.oldText.length} 字符）`
    case 'rename':
      return `将 ${confirmation.fromPath} 重命名为 ${confirmation.toPath}`
    case 'delete':
      return `将删除 ${confirmation.path}（移入回收站）`
  }
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
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
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
