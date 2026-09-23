import {
  createChatSession,
  enqueueChatMessage,
  wakeChatDriver,
  stopChatDriver,
  isChatDriverActive,
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
} from '../core/chat/session'
import {
  removeFromInbox,
  replaceInInbox,
  moveToNextStep,
} from '../core/chat/inbox'
import {
  saveSession,
  loadSession,
  deleteSessionFile,
  listSessionMetas,
} from '../core/chat/session-store'
import { deriveChatTargetFromPath } from '../core/chat/target'
import { readNovAiOverview, readScenePrompt, readSystemPrompt } from '../core/fs/project-fs'
import { countDiffLines } from '../core/tools/file-tools/diff-line-stats'
import type { ConfirmHandler } from '../core/agent/tool-execution'
import { INIT_NOVEL_PROMPT } from '../core/agent/init-novel-prompt'
import type { FileChange, WriteConfirmation } from '../core/tools/types'
import type { ChatMessage, ChatSessionState, ChatTargetContext, FileChangeRecord } from '../types/chat'
import type { ProjectSnapshot } from '../types/project'

/**
 * /生成项目记忆 斜杠命令的驱动 prompt。
 * app 层通过 services 入口导入，选中命令后作为用户意图发送给 Agent，由 Agent 扫描项目并生成/更新 prompts/NovAI.md。
 */
export { INIT_NOVEL_PROMPT }

import {
  requireRuntimeProject,
} from './project-runtime'
import type {
  AgentUiEvent,
  ChangedFileView,
  FileChangeRecordView,
  ChatHistoryPageView,
  ChatMessageView,
  ChatSessionSummaryView,
  ChatSessionView,
  ChatTargetView,
  FileChangeConfirmationView,
  NovAiError,
  QueuedMessageView,
  RunAgentTurnResult,
  ToolNameView,
  TurnFileChangeView,
  WriteConfirmationView,
} from './types'

/**
 * 会话内存态：key 为 sessionId（一个项目可同时驻留多个历史会话）。
 * 从「单项目单会话」升级为「多会话」，支持历史会话切换。
 *
 * 用 Map 的插入顺序天然作为 LRU：访问/写入时 delete+set 把条目移到末尾（最近），
 * 超过 MAX_CACHED_SESSIONS 时从头部（最旧）淘汰。项目关闭时由 evictProjectSessions
 * 整体清理该项目条目，避免长期累积内存泄漏。
 */
const sessionMap = new Map<string, ChatSessionState>()

/** 内存驻留会话上限。超过则按 LRU 淘汰最旧条目；冷数据回退到从盘读取。 */
const MAX_CACHED_SESSIONS = 16

// 确认注册表：confirmationId -> resolve。UI 调 respondConfirmation 时取出来 resolve，
// 唤醒在 confirm 回调里 await 的 Agent Loop。
type PendingConfirmation = {
  projectId: string
  resolve: (decision: { accepted: boolean }) => void
}
const confirmationMap = new Map<string, PendingConfirmation>()

/** 每个项目当前激活的会话 id；新建/切换/删除时维护。 */
const activeSessionByProject = new Map<string, string>()

/**
 * 写入会话缓存：delete 后 set 把条目移到 Map 末尾（标记为最近使用），
 * 再在超限时淘汰头部（最旧）。所有缓存插入统一走这里，保证 LRU 一致性。
 *
 * 导出仅供单测直接驱动缓存（验证 LRU 淘汰 / 项目级清理），业务代码不应直接调用。
 */
export function cacheSession(session: ChatSessionState) {
  sessionMap.delete(session.sessionId)
  sessionMap.set(session.sessionId, session)
  while (sessionMap.size > MAX_CACHED_SESSIONS) {
    const oldest = sessionMap.keys().next().value
    if (oldest === undefined) {
      break
    }
    sessionMap.delete(oldest)
  }
}

/**
 * 项目级清理：移除该项目的所有驻留会话 + 激活态。
 * 供 closeProject / deleteRecentProject 在释放运行时项目时调用，避免历史会话累积泄漏。
 */
export function evictProjectSessions(projectId: string) {
  for (const [id, session] of sessionMap) {
    if (session.projectId === projectId) {
      sessionMap.delete(id)
    }
  }
  for (const [id, tombstoneProjectId] of deletedSessionIds) {
    if (tombstoneProjectId === projectId) {
      deletedSessionIds.delete(id)
    }
  }
  activeSessionByProject.delete(projectId)
  lastActiveFilePathByProject.delete(projectId)
}

/** 测试专用：重置 module-global 缓存，避免用例间状态串扰。 */
export function _clearSessionCacheForTest() {
  sessionMap.clear()
  activeSessionByProject.clear()
  lastActiveFilePathByProject.clear()
  deletedSessionIds.clear()
}

/** 测试专用：读取当前缓存内的 sessionId 列表（按 LRU 顺序，最近使用在末尾）。 */
export function _getCachedSessionIdsForTest(): string[] {
  return Array.from(sessionMap.keys())
}

export function deriveTargetFromPath(path?: string | null): ChatTargetView | null {
  return toChatTargetView(deriveChatTargetFromPath(path))
}

export async function createSession(projectId: string): Promise<ChatSessionView> {
  const project = requireRuntimeProject(projectId)

  const session = createChatSession(projectId)
  cacheSession(session)
  activeSessionByProject.set(projectId, session.sessionId)

  // 新建即落盘，确保列表能立即看到（即便用户还没发消息）
  await saveSession(project, session)

  return toChatSessionView(session)
}

/**
 * 取会话视图。sessionId 缺省时返回该项目当前激活会话。
 * 内存未命中时从文件系统加载并缓存，支持「冷启动后查看历史会话」。
 *
 * options.tailMessages：只返回尾部 N 条消息（长会话分页窗口，游标为 append-only
 * 数组下标）；不传返回全量。截断时 view 带 historyStart（窗口首条的全量下标）。
 */
export async function getSession(
  projectId: string,
  sessionId?: string,
  options?: { tailMessages?: number },
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

  return toChatSessionView(session, options)
}

/**
 * 往前翻一页历史：返回窗口 [start, before) 的消息视图。
 * before = 当前窗口起点（全量数组下标），钳制到 [0, 总数]；会话不存在返回 null。
 * 窗口内的 change-summary 照常从完整账本解析 changes。
 */
export async function loadOlderMessages(
  projectId: string,
  sessionId: string,
  options: { before: number; count: number },
): Promise<ChatHistoryPageView | null> {
  const session = await resolveSession(projectId, sessionId)
  if (!session) {
    return null
  }

  const total = session.messages.length
  const before = Math.min(Math.max(0, options.before), total)
  const start = Math.max(0, before - Math.max(0, options.count))
  return {
    messages: session.messages.slice(start, before).map((message) => toChatMessageView(message, session.changeLedger)),
    start,
  }
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

/** 已删除会话的墓碑（id → projectId）：driver 收尾回调据此静默丢弃，避免 saveSession 复活刚删的文件。不用 sessionMap 存在性判断——LRU 淘汰同样会把运行中会话移出缓存，会误伤正常收尾。 */
const deletedSessionIds = new Map<string, string>()

/** 删除会话：先停 driver（运行中的会话被删后，收尾落盘会把刚删的文件复活），再删文件 + 移出内存；若删的是激活会话则激活置空（由前端决定后续切到哪条）。 */
export async function deleteSession(projectId: string, sessionId: string): Promise<void> {
  const project = requireRuntimeProject(projectId)

  stopChatDriver(sessionId)
  deletedSessionIds.set(sessionId, projectId)
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
    // 命中即回插，刷新 LRU 顺序（最近使用移到末尾）
    cacheSession(cached)
    return cached
  }

  const project = requireRuntimeProject(projectId)
  const loaded = await loadSession(project, sessionId)
  if (!loaded) {
    return null
  }

  cacheSession(loaded)
  return loaded
}

// ---------- 事件总线（driver 后台跑，UI 靠订阅收事件；不再随单次调用 await 整轮） ----------

type AgentEventListener = (event: AgentUiEvent) => void
const agentEventListeners = new Set<AgentEventListener>()

/** 订阅 Agent 全局事件流（事件带 sessionId 路由，订阅方自行过滤激活会话）；返回退订函数。 */
export function subscribeAgentEvents(listener: AgentEventListener): () => void {
  agentEventListeners.add(listener)
  return () => {
    agentEventListeners.delete(listener)
  }
}

function broadcastAgentEvent(event: AgentUiEvent): void {
  for (const listener of agentEventListeners) {
    listener(event)
  }
}

/** 收件箱视图：next-turn → queued（排队），next-step → steering（插话），全量快照（队列很短）。 */
function toQueueView(session: ChatSessionState): QueuedMessageView[] {
  return [
    ...(session.inbox?.nextTurn ?? []).map((message) => ({ ...message, placement: 'queued' as const })),
    ...(session.inbox?.nextStep ?? []).map((message) => ({ ...message, placement: 'steering' as const })),
  ]
}

function broadcastQueueUpdated(session: ChatSessionState): void {
  broadcastAgentEvent({ type: 'queue-updated', sessionId: session.sessionId, queue: toQueueView(session) })
}

/**
 * 每个项目最近一次入队时的激活文件（唤醒快照的兜底来源）：主路径是消息级快照
 * （QueuedMessage.activeFilePath，排队多条各用各的）；仅旧队列消息无字段、或
 * steer-only 轮没有 followup 可携带时，driver 起跑才回退读这里。
 */
const lastActiveFilePathByProject = new Map<string, string | null>()

/**
 * 发送入口（入队永远先于唤醒）：消息先耐久入队会话收件箱，再唤醒 driver，立即返回。
 * - mode 'queue'：next-turn 排队，每条独占一个未来 turn（空闲时效果等同直接发送）；
 * - mode 'steer'：next-step 插话，下一个 step 边界整批生效。
 * driver 活着时不重复唤醒（core 闩锁：它在抽干点自己取；停止竞态由 pendingWake 兜底）。
 */
export async function enqueueMessage(input: {
  projectId: string
  sessionId?: string
  text: string
  quote?: string
  mode: 'queue' | 'steer'
  /** 发送时打开的文件路径（隐式上下文，目标解析用快照） */
  activeFilePath?: string | null
  /** 匿名联网配额身份（托管 linkseek 绿灯），由 app 层生成后随消息注入 */
  webClientId?: string
}): Promise<{ sessionId: string }> {
  const project = requireRuntimeProject(input.projectId)

  const session = input.sessionId
    ? await resolveSession(input.projectId, input.sessionId)
    : await resolveActiveOrCreate(input.projectId)
  if (!session) {
    throw new Error(`会话不存在或已删除：${input.sessionId}`)
  }

  cacheSession(session)
  activeSessionByProject.set(input.projectId, session.sessionId)
  if (input.activeFilePath !== undefined) {
    lastActiveFilePathByProject.set(input.projectId, input.activeFilePath)
  }

  // 首轮标题快照：唤醒前记下「此前无用户消息」与首批文本，driver 收尾时派生标题
  const hadNoUserMessage = !session.messages.some((m) => m.role === 'user')
  const titleBeforeRun = session.title

  enqueueChatMessage(session, input.mode === 'steer' ? 'next-step' : 'next-turn', {
    text: input.text,
    quote: input.quote,
    // 消息级快照：排队执行时按「发送那一刻」的文件解析目标，不被后来的入队覆盖
    ...(input.activeFilePath !== undefined ? { activeFilePath: input.activeFilePath } : {}),
  })
  // 耐久入队先于唤醒（刷新后队列还在，不自动消费）
  await saveSession(project, session)
  broadcastQueueUpdated(session)

  void wakeSessionDriver({
    project,
    session,
    webClientId: input.webClientId,
    titleContext: {
      hadNoUserMessage,
      titleBeforeRun,
      firstUserText: input.text,
    },
  })
  return { sessionId: session.sessionId }
}

/** 排队消息操作：编辑 / 删除（撤回）/ 立即插话（仅运行中可用，否则报错由 UI toast）。 */
export async function updateQueuedMessage(input: {
  projectId: string
  sessionId: string
  id: string
  action: { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' }
}): Promise<void> {
  const project = requireRuntimeProject(input.projectId)
  const session = await resolveSession(input.projectId, input.sessionId)
  if (!session) {
    throw new Error(`会话不存在或已删除：${input.sessionId}`)
  }

  if (input.action.kind === 'edit') {
    session.inbox = replaceInInbox(session.inbox, input.id, input.action.text)
  } else if (input.action.kind === 'remove') {
    session.inbox = removeFromInbox(session.inbox, input.id)
  } else {
    // 升级为插话：driver 活着才有下一抽干点；它会话对象共享，下一 step 边界自然生效，无需唤醒
    if (!isChatDriverActive(session.sessionId)) {
      throw new Error('仅运行中可把排队消息升级为插话')
    }
    session.inbox = moveToNextStep(session.inbox, input.id)
  }

  await saveSession(project, session)
  broadcastQueueUpdated(session)
}

/** 停止指定会话的运行：abort 当前 turn + 清闩锁；队列保留不自动续跑。 */
export function stopAgentRun(sessionId: string): void {
  stopChatDriver(sessionId)
}

/** 指定会话的 driver 是否活着（store 切换会话时恢复 isRunning 用）。 */
export function isAgentRunActive(sessionId: string): boolean {
  return isChatDriverActive(sessionId)
}

type DriverTitleContext = {
  hadNoUserMessage: boolean
  titleBeforeRun: string
  firstUserText: string
}

/**
 * 唤醒指定会话的 driver（组装本 wake 的 input 后交给 core 的 wakeChatDriver）。
 * 立即返回（fire-and-forget）；driver 生命周期事件经 onLifecycle 转成 run-start/run-finish/run-error 广播。
 */
async function wakeSessionDriver(options: {
  project: ProjectSnapshot
  session: ChatSessionState
  titleContext: DriverTitleContext
  webClientId?: string
}): Promise<void> {
  const { project, session, titleContext } = options
  const projectId = project.id

  const systemPrompt = await readSystemPrompt(project.handle)
  const scenePrompt = await readScenePrompt(
    project.handle,
    project.config.settings.activeScenePromptPath,
  )
  // 项目总览（prompts/NovAI.md）：每轮注入 system prompt，让 Agent 知道写到哪了、有哪些人物和伏笔。
  const novaiOverview = await readNovAiOverview(project.handle)
  // 写工具确认回调：构造预览 → 广播 confirmation-required → 等 UI 调 respondConfirmation。
  const confirm: ConfirmHandler = (request) => requestConfirmation(session.sessionId, projectId, request)

  // 账本基线：本次连续运行产生的记录 = 收尾时 slice(ledgerBaseline)（喂 turnChanges）
  const ledgerBaseline = session.changeLedger?.length ?? 0
  // file-changed 实时广播的高水位：message 事件到达时把账本新增段立即广播出去，
  // 前端据此在运行中刷新文件树 / 重读打开的文件（旧实现攒到 driver-finish 批量补发）。
  let emittedLedgerCount = ledgerBaseline

  wakeChatDriver({
    session,
    input: {
      // 指令走收件箱首批，driver 不直接消费 instruction/quote
      instruction: '',
      project,
      config: project.config,
      systemPrompt,
      scenePrompt,
      novaiOverview,
      activeFilePath: lastActiveFilePathByProject.get(projectId) ?? null,
      // 匿名联网配额身份：沿 ChatTurnInput → ToolRuntime 链注入 WebSearch/WebFetch
      ...(options.webClientId ? { webClientId: options.webClientId } : {}),
      confirm,
    },
    onEvent(event) {
      // 流式 delta 原样广播（携会话 id 供 UI 路由），不进 emitMessageEvent
      if (event.type === 'message-delta') {
        broadcastAgentEvent({
          type: 'message-delta',
          sessionId: session.sessionId,
          messageId: event.messageId,
          text: event.text,
        })
        return
      }
      // 收件箱被抽干（首批 claim / steer 抽干点）→ 全量快照广播
      if (event.type === 'inbox-updated') {
        broadcastQueueUpdated(event.session)
        return
      }
      // 账本追加紧排在 tool-result 的 pushMessage 之前（session.ts），故 message 事件
      // 到达时新记录必已在账本里：按高水位把新增段立即广播，不等整轮收敛。
      const ledger = event.session.changeLedger ?? []
      for (; emittedLedgerCount < ledger.length; emittedLedgerCount += 1) {
        broadcastAgentEvent({
          type: 'file-changed',
          sessionId: session.sessionId,
          file: toFileChangeRecordView(ledger[emittedLedgerCount]),
        })
      }
      emitMessageEvent(event.message, event.session.sessionId, event.session.changeLedger)
    },
    onLifecycle(event) {
      if (event.type === 'driver-start') {
        broadcastAgentEvent({ type: 'run-start', runId: createRunId(), sessionId: session.sessionId })
        return
      }
      void (async () => {
        // 会话已删（deleteSession 停止 driver 后的优雅收尾）：静默丢弃——
        // 此时 saveSession 会把刚删的会话文件复活，广播也会指向不存在的会话。
        if (deletedSessionIds.has(session.sessionId)) {
          rejectPendingConfirmations(projectId)
          return
        }
        if (event.type === 'driver-error') {
          // 出错时清理未决确认，避免注册表泄漏 / UI 卡在等待态。
          rejectPendingConfirmations(projectId)
          await saveSession(project, session)
          broadcastAgentEvent({ type: 'run-error', sessionId: session.sessionId, error: toNovAiError(event.error) })
          return
        }
        // driver-finish：标题派生（首个含用户消息的 turn）→ 落盘 → run-finish
        if (titleContext.hadNoUserMessage && titleContext.titleBeforeRun === DEFAULT_SESSION_TITLE) {
          session.title = deriveSessionTitle(titleContext.firstUserText)
        }
        cacheSession(session)
        await saveSession(project, session)

        const turnChanges = (session.changeLedger ?? []).slice(ledgerBaseline).map(toFileChangeRecordView)
        const result: RunAgentTurnResult = {
          projectId,
          sessionId: session.sessionId,
          targetPath: session.currentTarget?.primaryPath,
          turnChanges,
          sessionChangedFileCount: countSessionChangedFiles(session),
          session: toChatSessionView(session),
        }

        // file-changed 已在运行中按高水位实时广播过，收尾不再补发；run-finish 的
        // session.changedFiles 仍是权威清单，前端收到后整体覆盖。
        broadcastAgentEvent({ type: 'run-finish', sessionId: session.sessionId, result })
      })()
    },
  })
}

/**
 * 取当前激活会话；没有激活则新建并落盘。enqueueMessage 在未显式传 sessionId 时走此路径。
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
  cacheSession(session)
  activeSessionByProject.set(projectId, session.sessionId)
  await saveSession(project, session)
  return session
}

/**
 * 构造一次写工具确认：广播 confirmation-required 事件，返回 Promise 等待 respondConfirmation。
 * Agent Loop 在 confirm 回调里 await 它，从而在用户决定前暂停。
 */
function requestConfirmation(
  sessionId: string,
  projectId: string,
  request: { call: { id: string; name: ToolNameView }; confirmation: WriteConfirmation },
): Promise<{ accepted: boolean }> {
  const confirmationId = createRunId()
  const view: FileChangeConfirmationView = {
    id: confirmationId,
    toolName: request.call.name,
    title: buildConfirmationTitle(request.confirmation),
    summary: buildConfirmationSummary(request.confirmation),
    confirmation: toWriteConfirmationView(request.confirmation),
  }

  broadcastAgentEvent({ type: 'confirmation-required', sessionId, request: view })

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
  sessionId: string,
  ledger?: FileChangeRecord[],
) {
  const view = toChatMessageView(message, ledger)
  broadcastAgentEvent({ type: 'message', sessionId, message: view })

  if (message.kind === 'tool-call') {
    broadcastAgentEvent({
      type: 'tool-call',
      sessionId,
      toolCall: {
        id: message.id,
        name: message.toolName,
        inputSummary: message.inputSummary,
        createdAt: message.createdAt,
      },
    })
  }

  if (message.kind === 'tool-result') {
    broadcastAgentEvent({
      type: 'tool-result',
      sessionId,
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

function toChatSessionView(session: ChatSessionState, options?: { tailMessages?: number }): ChatSessionView {
  // 窗口切片：tailMessages 只影响 messages 视图；账本/清单/队列始终全量派生，
  // 窗口内 change-summary 的 changes 也照常从完整账本解析（map 时按 runId 匹配）。
  const start = options?.tailMessages === undefined
    ? 0
    : Math.max(0, session.messages.length - Math.max(0, options.tailMessages))
  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    status: session.status,
    messages: session.messages.slice(start).map((message) => toChatMessageView(message, session.changeLedger)),
    ...(start > 0 ? { historyStart: start } : {}),
    currentTargetPath: session.currentTarget?.primaryPath,
    changedFiles: collectSessionChangedFiles(session),
    changedFileCount: countSessionChangedFiles(session),
    queuedMessages: toQueueView(session),
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

/** 会话级改动清单：按目标路径去重（renamed 取 toPath），同路径保留最后一次变更类型。 */
function collectSessionChangedFiles(session: ChatSessionState): ChangedFileView[] {
  const byPath = new Map<string, ChangedFileView>()
  for (const record of session.changeLedger ?? []) {
    const view = toChangedFileView(record.change)
    const key = view.type === 'renamed' ? view.toPath : view.path
    byPath.set(key, view)
  }
  return [...byPath.values()]
}

/** 会话级改动文件总数：按目标路径去重（renamed 取 toPath），从改动账本派生——免疫压缩，重载不丢。 */
function countSessionChangedFiles(session: ChatSessionState): number {
  const paths = new Set<string>()
  for (const record of session.changeLedger ?? []) {
    paths.add(record.change.type === 'renamed' ? record.change.toPath : record.change.path)
  }
  return paths.size
}

/**
 * 本轮改动按文件聚合（写回面板数据）：一轮内同一文件的多次操作折叠为一个文件行。
 * 账本顺序扫描；renamed 把已有组迁到 toPath（改名前后的内容修改归同一文件）。
 * 净状态按首/末次内容操作判定：末次为 deleted → deleted（新建后又删除也归此列——
 * 丢弃整组会让面板降级成「改动记录缺失」，误导为数据异常；保留为删除行、
 * 新建记录留在 records 里，点开可见完整经过）；删除后又重建 → updated（文件本轮前已存在）。
 */
function collectTurnFileChanges(records: FileChangeRecord[]): TurnFileChangeView[] {
  type Group = {
    path: string
    fromPath?: string
    renamed: boolean
    /** 首/末次内容操作类型（renamed 不参与净状态判定） */
    firstContentType?: 'created' | 'updated' | 'deleted'
    lastContentType?: 'created' | 'updated' | 'deleted'
    records: FileChangeRecord[]
  }
  const groups = new Map<string, Group>()

  for (const record of records) {
    const change = record.change
    if (change.type === 'renamed') {
      const existing = groups.get(change.fromPath)
      if (existing) {
        groups.delete(change.fromPath)
        existing.path = change.toPath
        existing.fromPath = existing.fromPath ?? change.fromPath
        existing.renamed = true
        existing.records.push(record)
        groups.set(change.toPath, existing)
      } else {
        groups.set(change.toPath, {
          path: change.toPath,
          fromPath: change.fromPath,
          renamed: true,
          records: [record],
        })
      }
      continue
    }

    const group = groups.get(change.path) ?? { path: change.path, renamed: false, records: [] }
    group.firstContentType = group.firstContentType ?? change.type
    group.lastContentType = change.type
    group.records.push(record)
    groups.set(change.path, group)
  }

  const files: TurnFileChangeView[] = []
  for (const group of groups.values()) {
    const status = group.lastContentType === 'deleted'
      ? 'deleted'
      : group.firstContentType === 'created'
        ? 'created'
        : group.renamed
          ? 'renamed'
          : 'updated'
    const views = group.records.map(toFileChangeRecordView)
    // 行数不按记录里存的值求和，而对 oldText/newText 实时重算：
    // 与展开的 DiffLines 渲染同源必然一致，且历史账本里旧净差口径的数字随之自愈
    let linesAdded = 0
    let linesRemoved = 0
    for (const record of views) {
      // 删除记录无片段 diff，行数取删除时落账的 linesRemoved（旧账本无此字段，贡献 0）
      if (record.change.type === 'deleted') {
        linesRemoved += record.change.linesRemoved ?? 0
        continue
      }
      if (!record.diff) {
        continue
      }
      const stats = countDiffLines(record.diff.oldText, record.diff.newText)
      linesAdded += stats.linesAdded
      linesRemoved += stats.linesRemoved
    }
    files.push({
      path: group.path,
      ...(group.fromPath ? { fromPath: group.fromPath } : {}),
      status,
      linesAdded,
      linesRemoved,
      records: views,
    })
  }
  return files
}

function toChatMessageView(message: ChatMessage, ledger?: FileChangeRecord[]): ChatMessageView {
  if (message.kind === 'text') {
    return {
      id: message.id,
      role: message.role,
      kind: 'text',
      text: message.text,
      // 仅 user text 消息有 quote/steered；assistant text 无此字段，undefined 自动忽略
      quote: 'quote' in message ? message.quote : undefined,
      steered: 'steered' in message ? message.steered : undefined,
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
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
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
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
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

  if (message.kind === 'turn-limit') {
    return {
      id: message.id,
      role: 'system',
      kind: 'turn-limit',
      text: message.summary,
      createdAt: message.createdAt,
    }
  }

  if (message.kind === 'change-summary') {
    // 面板数据按 runId 从账本解析并按文件聚合（消息本体只存 runId，不重复存 diff）；
    // 账本缺该 runId（异常旧数据）时 files 为空数组，UI 降级为一行文本。
    const files = collectTurnFileChanges(
      (ledger ?? []).filter((record) => record.runId === message.runId),
    )
    return {
      id: message.id,
      role: 'system',
      kind: 'change-summary',
      runId: message.runId,
      aborted: message.aborted,
      files,
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

function toFileChangeRecordView(record: FileChangeRecord): FileChangeRecordView {
  return {
    id: record.id,
    runId: record.runId,
    at: record.at,
    change: toChangedFileView(record.change),
    ...(record.diff ? { diff: { ...record.diff } } : {}),
  }
}

function toChangedFileView(change: FileChange): ChangedFileView {
  // core 的 FileChange 与 service 的 ChangedFileView 形状一致；
  // 显式映射而非直接透传，避免 service 层依赖 core 工具内部类型的结构。
  if (change.type === 'renamed') {
    return { type: 'renamed', fromPath: change.fromPath, toPath: change.toPath }
  }

  if (change.type === 'deleted') {
    return { type: 'deleted', path: change.path, trashPath: change.trashPath, ...(change.linesRemoved !== undefined ? { linesRemoved: change.linesRemoved } : {}) }
  }

  return { type: change.type, path: change.path }
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
