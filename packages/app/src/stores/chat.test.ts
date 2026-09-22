import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AgentUiEvent, ChatSessionView, RunAgentTurnResult } from '@novai/core/services/types'

import {
  createSession,
  enqueueMessage,
  getSession,
  isAgentRunActive,
  listSessions,
  stopAgentRun,
  subscribeAgentEvents,
} from '@novai/core/services/agent-service'
import { useChatStore } from './chat'

vi.mock('@novai/core/services/agent-service', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  enqueueMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  stopAgentRun: vi.fn(),
  isAgentRunActive: vi.fn(() => false),
  subscribeAgentEvents: vi.fn(() => () => {}),
  respondConfirmation: vi.fn(),
}))

const mockedCreateSession = vi.mocked(createSession)
const mockedGetSession = vi.mocked(getSession)
const mockedListSessions = vi.mocked(listSessions)
const mockedEnqueueMessage = vi.mocked(enqueueMessage)
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
})
