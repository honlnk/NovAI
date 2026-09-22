import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AgentUiEvent, ChatSessionView, RunAgentTurnResult } from '@novai/core/services/types'

import {
  createSession,
  enqueueMessage,
  getSession,
  isAgentRunActive,
  listSessions,
  loadOlderMessages,
  stopAgentRun,
  subscribeAgentEvents,
} from '@novai/core/services/agent-service'
import { HISTORY_PAGE_SIZE, useChatStore } from './chat'

vi.mock('@novai/core/services/agent-service', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  enqueueMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  loadOlderMessages: vi.fn(),
  stopAgentRun: vi.fn(),
  isAgentRunActive: vi.fn(() => false),
  subscribeAgentEvents: vi.fn(() => () => {}),
  respondConfirmation: vi.fn(),
}))

const mockedCreateSession = vi.mocked(createSession)
const mockedGetSession = vi.mocked(getSession)
const mockedListSessions = vi.mocked(listSessions)
const mockedEnqueueMessage = vi.mocked(enqueueMessage)
const mockedLoadOlderMessages = vi.mocked(loadOlderMessages)
const mockedStopAgentRun = vi.mocked(stopAgentRun)
const mockedIsAgentRunActive = vi.mocked(isAgentRunActive)
const mockedSubscribeAgentEvents = vi.mocked(subscribeAgentEvents)

function createSessionView(sessionId: string): ChatSessionView {
  return {
    sessionId,
    projectId: 'project-1',
    status: 'idle',
    messages: [],
    changedFiles: [],
    title: '新对话',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

/** 文本消息视图夹具：id 即全量下标（m-<index>），便于断言窗口切片边界 */
function createTextMessageView(index: number): ChatSessionView['messages'][number] {
  return {
    id: `m-${index}`,
    role: 'user',
    kind: 'text',
    text: `第 ${index} 条`,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(),
  }
}

/** 含 250 条消息的全量视图与尾部 100 条窗口视图（historyStart=150） */
function createWindowedSession(total = 250, tail = HISTORY_PAGE_SIZE) {
  const allMessages = Array.from({ length: total }, (_, index) => createTextMessageView(index))
  const start = Math.max(0, total - tail)
  const fullView: ChatSessionView = { ...createSessionView('session-current'), messages: allMessages }
  const windowedView: ChatSessionView = {
    ...createSessionView('session-current'),
    messages: allMessages.slice(start),
    ...(start > 0 ? { historyStart: start } : {}),
  }
  return { allMessages, fullView, windowedView, start }
}

function createRunResult(session: ChatSessionView, overrides: Partial<RunAgentTurnResult> = {}): RunAgentTurnResult {
  return {
    projectId: session.projectId,
    sessionId: session.sessionId,
    turnChanges: [],
    sessionChangedFileCount: 0,
    session,
    ...overrides,
  }
}

/** store 创建时订阅全局事件总线；取最近一次订阅的 listener 作为事件注入口 */
function captureListener(): (event: AgentUiEvent) => void {
  const calls = mockedSubscribeAgentEvents.mock.calls
  const call = calls[calls.length - 1]
  if (!call) {
    throw new Error('store 未订阅事件总线')
  }
  return call[0]
}

describe('chat store（W4 事件总线版）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockedListSessions.mockResolvedValue([])
    mockedIsAgentRunActive.mockReturnValue(false)
    mockedSubscribeAgentEvents.mockReturnValue(() => {})
    mockedEnqueueMessage.mockResolvedValue({ sessionId: 'session-current' })
  })

  it('旧会话残留的流式 delta 不写进当前会话视图（跨会话串扰防护）', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    // 用户切换/停留期间，另一个会话（旧运行）的残留 delta 抵达：必须丢弃
    emit({ type: 'message-delta', sessionId: 'session-stale', messageId: 'msg-stale', text: '旧会话的残留文本' })
    expect(store.messages).toHaveLength(0)
    expect(store.streamingMessageId).toBeNull()

    // 当前会话的 delta 正常落视图
    emit({ type: 'message-delta', sessionId: 'session-current', messageId: 'msg-1', text: '正常流式' })
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({ id: 'msg-1', kind: 'text', text: '正常流式' })
    expect(store.streamingMessageId).toBe('msg-1')
  })

  it('isRunning 由事件驱动：run-start 置真，run-finish 置假并写入会话级文案', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    expect(store.isRunning).toBe(false)
    emit({ type: 'run-start', runId: 'run-1', sessionId: 'session-current' })
    expect(store.isRunning).toBe(true)
    expect(store.runStatusType).toBe('running')

    const finishedView: ChatSessionView = {
      ...view,
      status: 'waiting-user',
      changedFiles: [{ type: 'updated', path: '正文/第1章.md' }],
      changedFileCount: 1,
    }
    emit({
      type: 'run-finish',
      sessionId: 'session-current',
      result: createRunResult(finishedView, { sessionChangedFileCount: 1 }),
    })
    expect(store.isRunning).toBe(false)
    expect(store.changedFiles).toEqual([{ type: 'updated', path: '正文/第1章.md' }])
    expect(store.runStatus).toBe('本会话共修改 1 个文件')
  })

  it('停止后立刻再发送：新 run 的 run-start 先于旧 run 的 run-finish 到达时 isRunning 保持 true', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    // 旧 driver 运行中
    emit({ type: 'run-start', runId: 'run-old', sessionId: 'session-current' })
    expect(store.isRunning).toBe(true)

    // 停止后立刻再发送：pendingWake 再唤醒的新 driver 已在注册表里，
    // 其 run-start 先于旧 driver 的 run-finish 到达（事件乱序）
    emit({ type: 'run-start', runId: 'run-new', sessionId: 'session-current' })

    // 旧 driver 的 run-finish 此时才抵达：注册表里新 driver 活着 → isRunning 不得被打掉
    mockedIsAgentRunActive.mockReturnValue(true)
    emit({
      type: 'run-finish',
      sessionId: 'session-current',
      result: createRunResult(view),
    })
    expect(store.isRunning).toBe(true)

    // run-error 同病同治：旧 driver 的 run-error 晚到也不打掉新 run
    emit({
      type: 'run-error',
      sessionId: 'session-current',
      error: { code: 'UNKNOWN_ERROR', message: '旧 run 的错误', recoverable: true },
    })
    expect(store.isRunning).toBe(true)

    // 新 driver 真正收尾（注册表已清）→ 才置 false
    mockedIsAgentRunActive.mockReturnValue(false)
    emit({
      type: 'run-finish',
      sessionId: 'session-current',
      result: createRunResult(view),
    })
    expect(store.isRunning).toBe(false)
  })

  it('queue-updated 同步队列快照；仅当前激活会话的事件生效', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    emit({
      type: 'queue-updated',
      sessionId: 'session-stale',
      queue: [{ id: 'q-stale', text: '别人的队列', at: '2026-09-19T00:00:00.000Z', placement: 'queued' }],
    })
    expect(store.queue).toHaveLength(0)

    emit({
      type: 'queue-updated',
      sessionId: 'session-current',
      queue: [{ id: 'q-1', text: '排队消息', at: '2026-09-19T00:00:00.000Z', placement: 'queued' }],
    })
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0]).toMatchObject({ id: 'q-1', placement: 'queued' })
  })

  it('file-changed 实时合并进会话级清单（目标路径去重、last-wins）', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    const record = (id: string, path: string) => ({
      id,
      runId: 'run-1',
      at: '2026-09-19T00:00:00.000Z',
      change: { type: 'updated' as const, path },
    })
    emit({ type: 'file-changed', sessionId: 'session-current', file: record('c-1', 'a.md') })
    emit({ type: 'file-changed', sessionId: 'session-current', file: record('c-2', 'b.md') })
    // 同文件再改一次：不重复占位
    emit({ type: 'file-changed', sessionId: 'session-current', file: record('c-3', 'a.md') })
    expect(store.changedFiles).toEqual([
      { type: 'updated', path: 'b.md' },
      { type: 'updated', path: 'a.md' },
    ])
  })

  it('lastFileChange 逐条记录 file-changed 原文（同文件去重也不丢重读时机）；切会话时重置', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    const record = (id: string, path: string) => ({
      id,
      runId: 'run-1',
      at: '2026-09-19T00:00:00.000Z',
      change: { type: 'updated' as const, path },
    })
    emit({ type: 'file-changed', sessionId: 'session-current', file: record('c-1', 'a.md') })
    emit({ type: 'file-changed', sessionId: 'session-current', file: record('c-2', 'a.md') })
    // 清单层去重后 a.md 只占一位；lastFileChange 仍逐条前进（内容面板每次都要重读）
    expect(store.changedFiles).toHaveLength(1)
    expect(store.lastFileChange).toMatchObject({ id: 'c-2' })

    // 别的会话的事件不串扰
    emit({ type: 'file-changed', sessionId: 'session-stale', file: record('c-x', 'x.md') })
    expect(store.lastFileChange).toMatchObject({ id: 'c-2' })

    // 切换会话重置，避免旧会话残留触发误重读
    mockedGetSession.mockResolvedValue({ ...createSessionView('session-other'), changedFiles: [] })
    await store.selectSession('project-1', 'session-other')
    expect(store.lastFileChange).toBeNull()
  })

  it('sendMessage 成功返回 true 并透传 mode/quote；失败返回 false 供草稿恢复', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })

    const ok = await store.sendMessage('写一段开头', '引用文本', 'steer')
    expect(ok).toBe(true)
    expect(mockedEnqueueMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sessionId: 'session-current',
      text: '写一段开头',
      quote: '引用文本',
      mode: 'steer',
    }))

    mockedEnqueueMessage.mockRejectedValueOnce(new Error('会话不存在或已删除'))
    const failed = await store.sendMessage('再写一段')
    expect(failed).toBe(false)
    expect(store.runStatusType).toBe('error')
  })

  it('abortRun 调 stopAgentRun 并进入停止中态；run-error 收敛运行态', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })
    const emit = captureListener()

    // 未运行时停止是 no-op
    store.abortRun()
    expect(mockedStopAgentRun).not.toHaveBeenCalled()

    emit({ type: 'run-start', runId: 'run-1', sessionId: 'session-current' })
    store.abortRun()
    expect(mockedStopAgentRun).toHaveBeenCalledWith('session-current')
    expect(store.isStopping).toBe(true)

    emit({
      type: 'run-error',
      sessionId: 'session-current',
      error: { code: 'UNKNOWN_ERROR', message: '炸了', recoverable: true },
    })
    expect(store.isRunning).toBe(false)
    expect(store.isStopping).toBe(false)
    expect(store.runStatusType).toBe('error')
  })

  it('切换会话时从 view 重建队列/改动清单/运行态', async () => {
    const store = useChatStore()
    const runningView: ChatSessionView = {
      ...createSessionView('session-running'),
      changedFiles: [{ type: 'created', path: '正文/第2章.md' }],
      queuedMessages: [{ id: 'q-1', text: '排队中', at: '2026-09-19T00:00:00.000Z', placement: 'queued' }],
    }
    mockedGetSession.mockResolvedValue(runningView)
    mockedIsAgentRunActive.mockReturnValue(true)

    await store.selectSession('project-1', 'session-running')
    expect(store.activeSessionId).toBe('session-running')
    expect(store.queue).toHaveLength(1)
    expect(store.changedFiles).toEqual([{ type: 'created', path: '正文/第2章.md' }])
    expect(store.isRunning).toBe(true)
  })

  // ---------- 历史分页窗口（HISTORY_PAGE_SIZE=100） ----------

  it('selectSession 只装尾部窗口：按页大小请求、hasMoreHistory 由 historyStart 推导', async () => {
    const store = useChatStore()
    const { windowedView, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)

    await store.selectSession('project-1', 'session-current')
    expect(mockedGetSession).toHaveBeenCalledWith('project-1', 'session-current', { tailMessages: HISTORY_PAGE_SIZE })
    expect(store.messages).toHaveLength(HISTORY_PAGE_SIZE)
    expect(store.messages[0].id).toBe(`m-${start}`)
    expect(store.historyStart).toBe(start)
    expect(store.hasMoreHistory).toBe(true)
  })

  it('selectSession 短会话无 historyStart：hasMoreHistory 为 false（向后兼容旧 view）', async () => {
    const store = useChatStore()
    mockedGetSession.mockResolvedValue(createSessionView('session-short'))

    await store.selectSession('project-1', 'session-short')
    expect(store.historyStart).toBe(0)
    expect(store.hasMoreHistory).toBe(false)
    expect(store.loadingOlder).toBe(false)
  })

  it('loadOlderHistory prepend：旧页接到头部、窗口起点前移、顺序不乱', async () => {
    const store = useChatStore()
    const { windowedView, allMessages, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)
    await store.selectSession('project-1', 'session-current')

    mockedLoadOlderMessages.mockResolvedValue({
      messages: allMessages.slice(start - HISTORY_PAGE_SIZE, start),
      start: start - HISTORY_PAGE_SIZE,
    })
    const loaded = await store.loadOlderHistory()
    expect(loaded).toBe(true)
    expect(mockedLoadOlderMessages).toHaveBeenCalledWith('project-1', 'session-current', {
      before: start,
      count: HISTORY_PAGE_SIZE,
    })
    expect(store.messages).toHaveLength(200)
    expect(store.messages[0].id).toBe(`m-${start - HISTORY_PAGE_SIZE}`)
    expect(store.messages[99].id).toBe(`m-${start - 1}`)
    expect(store.messages[100].id).toBe(`m-${start}`)
    expect(store.historyStart).toBe(start - HISTORY_PAGE_SIZE)
    expect(store.loadingOlder).toBe(false)
  })

  it('loadOlderHistory 防重入：在途请求未落地时第二次调用不再发请求', async () => {
    const store = useChatStore()
    const { windowedView, allMessages, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)
    await store.selectSession('project-1', 'session-current')

    let resolvePage: ((page: { messages: ChatSessionView['messages']; start: number }) => void) | null = null
    mockedLoadOlderMessages.mockImplementation(
      () => new Promise((resolve) => { resolvePage = resolve }),
    )
    const first = store.loadOlderHistory()
    const second = store.loadOlderHistory()
    expect(mockedLoadOlderMessages).toHaveBeenCalledTimes(1)
    expect(store.loadingOlder).toBe(true)

    resolvePage!({
      messages: allMessages.slice(start - HISTORY_PAGE_SIZE, start),
      start: start - HISTORY_PAGE_SIZE,
    })
    await first
    await second
    expect(store.messages).toHaveLength(200)
    expect(store.loadingOlder).toBe(false)
  })

  it('loadOlderHistory 翻到顶：空页落地后 hasMoreHistory 归 false', async () => {
    const store = useChatStore()
    const { windowedView, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)
    await store.selectSession('project-1', 'session-current')

    mockedLoadOlderMessages.mockResolvedValue({ messages: [], start: 0 })
    const loaded = await store.loadOlderHistory()
    expect(loaded).toBe(false)
    expect(store.historyStart).toBe(0)
    expect(store.hasMoreHistory).toBe(false)
    expect(store.messages).toHaveLength(HISTORY_PAGE_SIZE)
  })

  it('loadOlderHistory 无更多历史 / 无会话时是 no-op，不发请求', async () => {
    const store = useChatStore()
    expect(await store.loadOlderHistory()).toBe(false)
    expect(mockedLoadOlderMessages).not.toHaveBeenCalled()

    mockedGetSession.mockResolvedValue(createSessionView('session-short'))
    await store.selectSession('project-1', 'session-short')
    expect(await store.loadOlderHistory()).toBe(false)
    expect(mockedLoadOlderMessages).not.toHaveBeenCalled()
  })

  it('run-finish 全量覆盖时历史窗口保持：按窗口起点切片，翻页成果不被冲掉', async () => {
    const store = useChatStore()
    const { windowedView, fullView, allMessages, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)
    await store.selectSession('project-1', 'session-current')
    const emit = captureListener()

    // 翻一页后再收尾：运行中翻页是合法姿态，窗口起点必须保持
    mockedLoadOlderMessages.mockResolvedValue({
      messages: allMessages.slice(start - HISTORY_PAGE_SIZE, start),
      start: start - HISTORY_PAGE_SIZE,
    })
    await store.loadOlderHistory()
    expect(store.messages).toHaveLength(200)

    emit({
      type: 'run-finish',
      sessionId: 'session-current',
      // 全量比 select 时多一条（本轮新产生的 assistant 回答）
      result: createRunResult({ ...fullView, messages: [...allMessages, createTextMessageView(250)] }),
    })
    expect(store.messages).toHaveLength(201)
    expect(store.messages[0].id).toBe(`m-${start - HISTORY_PAGE_SIZE}`)
    expect(store.messages[200].id).toBe('m-250')
    expect(store.historyStart).toBe(start - HISTORY_PAGE_SIZE)
  })

  it('窗口化后 message-delta 仍在尾部追加（起点不动）', async () => {
    const store = useChatStore()
    const { windowedView, start } = createWindowedSession()
    mockedGetSession.mockResolvedValue(windowedView)
    await store.selectSession('project-1', 'session-current')
    const emit = captureListener()

    emit({ type: 'message-delta', sessionId: 'session-current', messageId: 'msg-stream', text: '流式片段' })
    expect(store.messages).toHaveLength(HISTORY_PAGE_SIZE + 1)
    expect(store.messages[0].id).toBe(`m-${start}`)
    expect(store.messages[HISTORY_PAGE_SIZE]).toMatchObject({ id: 'msg-stream', text: '流式片段' })
    expect(store.historyStart).toBe(start)
  })
})
