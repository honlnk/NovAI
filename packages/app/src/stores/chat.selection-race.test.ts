import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentUiEvent, ChatSessionView } from '@novai/core/services/types'

import { useChatStore } from './chat'

/**
 * 选择归属与运行身份的乱序事件序（数据安全计划第二波 F6/F8/F9 自动化验收 1/2/5/6/7）：
 * 用户的选择意图以代次为准——晚到的读取结果不得改变当前现场；
 * 会话的收尾事件以运行身份（runId）为准——旧运行的完成结果不得覆盖新运行的视图。
 * 测试用受控 Promise 精确控制完成顺序，不依赖延时。
 */

const getAgentSession = vi.hoisted(() => vi.fn())
const createAgentSession = vi.hoisted(() => vi.fn())
const listAgentSessions = vi.hoisted(() => vi.fn())
const isAgentRunActive = vi.hoisted(() => vi.fn())
const eventHandlers = vi.hoisted(() => new Array<(event: AgentUiEvent) => void>())

vi.mock('@novai/core/services/agent-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/agent-service')>()
  return {
    ...actual,
    getSession: getAgentSession,
    createSession: createAgentSession,
    listSessions: listAgentSessions,
    isAgentRunActive,
    subscribeAgentEvents: (handler: (event: AgentUiEvent) => void) => {
      eventHandlers.push(handler)
      return () => {}
    },
  }
})

function fakeView(sessionId: string, projectId = 'proj-1'): ChatSessionView {
  return {
    sessionId,
    projectId,
    messages: [],
    title: `会话${sessionId}`,
    status: 'idle',
  } as unknown as ChatSessionView
}

/** 受控读取：按 sessionId 挂起，测试手动放行 */
function holdSessionReads() {
  const pending = new Map<string, Array<(value: ChatSessionView | null) => void>>()
  getAgentSession.mockImplementation((_projectId: string, sessionId: string) =>
    new Promise((resolve) => {
      const list = pending.get(sessionId) ?? []
      list.push(resolve)
      pending.set(sessionId, list)
    }))
  return {
    release(sessionId: string, view: ChatSessionView | null) {
      const list = pending.get(sessionId) ?? []
      pending.delete(sessionId)
      for (const resolve of list) {
        resolve(view)
      }
    },
  }
}

function emitEvent(event: AgentUiEvent) {
  const handler = eventHandlers[eventHandlers.length - 1]
  if (!handler) {
    throw new Error('事件总线尚未订阅')
  }
  handler(event)
}

describe('F6 会话选择代次（验收1：甲慢乙快，最终只展示乙）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
  })

  it('点击顺序甲后乙、完成顺序乙先甲：激活会话与视图必须是乙', async () => {
    const store = useChatStore()
    const reads = holdSessionReads()

    const selectA = store.selectSession('proj-1', '甲')
    const selectB = store.selectSession('proj-1', '乙')
    reads.release('乙', fakeView('乙'))
    await selectB
    reads.release('甲', fakeView('甲'))
    await selectA

    expect(store.activeSessionId).toBe('乙')
    expect(store.sessionView?.sessionId).toBe('乙')
  })

  it('完成顺序甲先乙（甲后完成仍是过期读取）：激活会话仍是乙', async () => {
    const store = useChatStore()
    const reads = holdSessionReads()

    const selectA = store.selectSession('proj-1', '甲')
    const selectB = store.selectSession('proj-1', '乙')
    reads.release('甲', fakeView('甲'))
    await selectA
    reads.release('乙', fakeView('乙'))
    await selectB

    expect(store.activeSessionId).toBe('乙')
    expect(store.sessionView?.sessionId).toBe('乙')
  })

  it('验收2：无会话时连续新建（甲慢乙快）——最终激活乙', async () => {
    const store = useChatStore()

    let releaseA!: (value: ChatSessionView) => void
    let releaseB!: (value: ChatSessionView) => void
    createAgentSession
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseA = resolve
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseB = resolve
      }))
      .mockResolvedValue(fakeView('后续') as never)

    const createA = store.createNewSession('proj-1', { skipReload: true })
    const createB = store.createNewSession('proj-1', { skipReload: true })
    releaseB(fakeView('乙'))
    await createB
    releaseA(fakeView('甲'))
    await createA

    expect(store.activeSessionId).toBe('乙')
    expect(store.sessionView?.sessionId).toBe('乙')
  })

  it('甲的后台事件仍只更新甲（不因乙激活而被清空或串到乙）', () => {
    const store = useChatStore()
    store.activeSessionId = '乙'
    store.sessionView = fakeView('乙')

    // 甲的 run-finish（旧运行收尾）：只允许列表摘要级更新，不得覆盖乙的视图
    emitEvent({
      type: 'run-finish',
      sessionId: '甲',
      runId: 'run-甲-1',
      result: {
        projectId: 'proj-1',
        sessionId: '甲',
        turnChanges: [],
        sessionChangedFileCount: 0,
        session: fakeView('甲'),
      },
    } as unknown as AgentUiEvent)

    expect(store.activeSessionId).toBe('乙')
    expect(store.sessionView?.sessionId).toBe('乙')
  })
})

describe('F8 运行身份（验收5：旧运行完成晚于新运行消息）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
  })

  it('旧 run-finish 晚于新 run 的流式消息：新视图不被旧快照覆盖', () => {
    const store = useChatStore()
    store.activeSessionId = '甲'
    store.sessionView = {
      ...fakeView('甲'),
      messages: [{
        id: 'm-new',
        role: 'assistant',
        kind: 'text',
        text: '新运行正在生成的消息',
        createdAt: '2026-11-08T12:00:00.000Z',
      }],
    } as ChatSessionView
    store.streamingMessageId = 'm-new'

    // 旧运行 start（先）→ 新运行 start（后）：注册表以新运行为准
    isAgentRunActive.mockReturnValue(true)
    emitEvent({ type: 'run-start', runId: 'run-old', sessionId: '甲' })
    emitEvent({ type: 'run-start', runId: 'run-new', sessionId: '甲' })

    // 旧运行收尾晚到（runId 过期）：不得覆盖新运行的流式视图与运行状态
    emitEvent({
      type: 'run-finish',
      sessionId: '甲',
      runId: 'run-old',
      result: {
        projectId: 'proj-1',
        sessionId: '甲',
        turnChanges: [],
        sessionChangedFileCount: 0,
        session: fakeView('甲'),
      },
    } as unknown as AgentUiEvent)

    expect(store.sessionView?.messages.some((m) => m.id === 'm-new')).toBe(true)
    expect(store.streamingMessageId).toBe('m-new')
    expect(store.runStatusType).not.toBe('idle')
    // 运行态以注册表为准（新运行仍在跑）
    expect(store.isRunning).toBe(true)
  })

  it('旧 run-error 晚于新运行：不把状态栏打成错误、不打断新运行', () => {
    const store = useChatStore()
    store.activeSessionId = '甲'
    store.sessionView = fakeView('甲')

    isAgentRunActive.mockReturnValue(true)
    emitEvent({ type: 'run-start', runId: 'run-old', sessionId: '甲' })
    emitEvent({ type: 'run-start', runId: 'run-new', sessionId: '甲' })
    store.setRunStatus('Agent 正在执行...', 'running')

    emitEvent({
      type: 'run-error',
      sessionId: '甲',
      runId: 'run-old',
      error: { name: 'AbortedError', message: '已停止' } as never,
    } as unknown as AgentUiEvent)

    expect(store.runStatusType).toBe('running')
    expect(store.isRunning).toBe(true)
  })

  it('当前运行的 run-finish 正常收敛（新快照被接受，流式态清空）', () => {
    const store = useChatStore()
    store.activeSessionId = '甲'
    store.sessionView = fakeView('甲')
    store.streamingMessageId = 'm-new'

    isAgentRunActive.mockReturnValue(false)
    emitEvent({ type: 'run-start', runId: 'run-new', sessionId: '甲' })
    const finished = { ...fakeView('甲'), title: '收尾后的标题' }
    emitEvent({
      type: 'run-finish',
      sessionId: '甲',
      runId: 'run-new',
      result: {
        projectId: 'proj-1',
        sessionId: '甲',
        turnChanges: [],
        sessionChangedFileCount: 2,
        session: finished,
      },
    } as unknown as AgentUiEvent)

    // 新快照被接受（pinia reactive 代理下按字段断言）
    expect(store.sessionView?.title).toBe('收尾后的标题')
    expect(store.streamingMessageId).toBeNull()
    expect(store.isRunning).toBe(false)
  })
})

describe('F9 后台会话归属（验收7：后台变化不清当前确认与现场）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
  })

  it('后台会话的 file-changed / queue-updated 不切换当前会话、不清待确认', () => {
    const store = useChatStore()
    store.activeSessionId = '主会话'
    store.sessionView = fakeView('主会话')

    emitEvent({
      type: 'confirmation-required',
      sessionId: '主会话',
      request: { id: 'cf-1', targetPath: 'chapters/a.txt', diff: { kind: 'edit', path: 'chapters/a.txt', oldText: '旧', newText: '新' } } as never,
    })
    expect(store.pendingConfirmationsBySession.get('主会话')).toHaveLength(1)

    // 后台委派会话的文件改动与队列变化
    emitEvent({
      type: 'file-changed',
      sessionId: '后台会话',
      file: {
        id: 'r1',
        change: { type: 'updated', path: 'chapters/a.txt' },
        coords: null,
        diff: null,
      } as never,
    })
    emitEvent({ type: 'queue-updated', sessionId: '后台会话', queue: [] })

    expect(store.activeSessionId).toBe('主会话')
    expect(store.sessionView?.sessionId).toBe('主会话')
    // 当前会话的待确认不被后台事件清掉
    expect(store.pendingConfirmationsBySession.get('主会话')).toHaveLength(1)
    // 后台改动进入最近反馈队列并带会话归属（供通知不抢现场）
    expect(store.recentFileChanges[store.recentFileChanges.length - 1]?.sessionId).toBe('后台会话')
  })
})
