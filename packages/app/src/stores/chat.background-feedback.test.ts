import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentUiEvent, ChatSessionView } from '@novai/core/services/types'

import { useChatStore } from './chat'
import { useProjectStore } from './project'
import { useToast } from '../composables/useToast'

/**
 * 第三波后台反馈与残留清理（数据安全计划 F10–F12 自动化验收 1/3）：
 * - 后台会话完成/失败更新列表摘要与持续错误提示，当前现场不被切换；
 * - 删除运行中的后台会话后各标记集合立即清空，晚到事件不得复活任何标记；
 * - 进入会话现场后该会话的保存失败记录随之清除（错误持续性出口）。
 */

const getAgentSession = vi.hoisted(() => vi.fn())
const createAgentSession = vi.hoisted(() => vi.fn())
const listAgentSessions = vi.hoisted(() => vi.fn())
const isAgentRunActive = vi.hoisted(() => vi.fn())
const deleteAgentSession = vi.hoisted(() => vi.fn())
const eventHandlers = vi.hoisted(() => new Array<(event: AgentUiEvent) => void>())

vi.mock('@novai/core/services/agent-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/agent-service')>()
  return {
    ...actual,
    getSession: getAgentSession,
    createSession: createAgentSession,
    listSessions: listAgentSessions,
    isAgentRunActive,
    deleteSession: deleteAgentSession,
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

function emitEvent(event: AgentUiEvent) {
  const handler = eventHandlers[eventHandlers.length - 1]
  if (!handler) {
    throw new Error('事件总线尚未订阅')
  }
  handler(event)
}

function seedActiveSession(store: ReturnType<typeof useChatStore>) {
  store.activeSessionId = '甲'
  store.sessionView = fakeView('甲')
  store.sessions = [
    { sessionId: '乙', title: '后台会话乙', updatedAt: '2026-11-08T12:00:00.000Z' },
    { sessionId: '甲', title: '会话甲', updatedAt: '2026-11-08T11:00:00.000Z' },
  ] as never
}

describe('F11 后台完成与失败（验收1：乙的摘要和通知更新，当前现场不变）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().currentProject = { id: 'proj-1', name: '项目一', files: [] } as never
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
    useToast().toasts.value.splice(0)
  })

  it('后台会话乙 run-finish：列表刷新（摘要级），激活会话与视图保持甲', async () => {
    const store = useChatStore()
    const projectStore = useProjectStore()
    projectStore.currentProject = { id: 'proj-1', name: '甲项目', files: [] } as never
    seedActiveSession(store)
    listAgentSessions.mockResolvedValue([
      { sessionId: '乙', title: '乙的新标题', updatedAt: '2026-11-08T13:00:00.000Z' },
      { sessionId: '甲', title: '会话甲', updatedAt: '2026-11-08T11:00:00.000Z' },
    ] as never)

    emitEvent({
      type: 'run-finish',
      sessionId: '乙',
      runId: 'run-乙-1',
      result: {
        projectId: 'proj-1',
        sessionId: '乙',
        turnChanges: [],
        sessionChangedFileCount: 0,
        session: fakeView('乙'),
      },
    } as unknown as AgentUiEvent)
    // 列表刷新是 fire-and-forget，等微任务排空
    await vi.waitFor(() => expect(listAgentSessions).toHaveBeenCalled())

    expect(store.activeSessionId).toBe('甲')
    expect(store.sessionView?.sessionId).toBe('甲')
    // 后台乙的运行标记同时收敛
    expect(store.runningSessionIds.has('乙')).toBe(false)
  })

  it('后台会话乙 run-finish 属于别的项目（切项目后晚到）：不刷新当前项目列表', () => {
    const store = useChatStore()
    const projectStore = useProjectStore()
    projectStore.currentProject = { id: 'proj-2', name: '乙项目', files: [] } as never
    seedActiveSession(store)

    emitEvent({
      type: 'run-finish',
      sessionId: '乙',
      runId: 'run-乙-1',
      result: {
        projectId: 'proj-1',
        sessionId: '乙',
        turnChanges: [],
        sessionChangedFileCount: 0,
        session: fakeView('乙'),
      },
    } as unknown as AgentUiEvent)

    // proj-2 的列表不被 proj-1 的晚到收尾改写
    expect(listAgentSessions).not.toHaveBeenCalled()
    expect(store.activeSessionId).toBe('甲')
  })

  it('后台会话乙 run-error：持续错误 toast 可见，甲的运行状态栏不受影响', () => {
    const store = useChatStore()
    seedActiveSession(store)
    store.setRunStatus('Agent 正在执行...', 'running')

    emitEvent({
      type: 'run-error',
      sessionId: '乙',
      runId: 'run-乙-1',
      error: { name: 'Error', message: '委派任务失败' } as never,
    } as unknown as AgentUiEvent)

    const { toasts } = useToast()
    const errorToast = toasts.value.find((t) => t.type === 'error')
    expect(errorToast?.message).toContain('后台会话乙')
    expect(errorToast?.message).toContain('委派任务失败')
    expect(errorToast?.persistent).toBe(true)

    expect(store.activeSessionId).toBe('甲')
    expect(store.runStatusType).toBe('running')
    expect(store.runningSessionIds.has('乙')).toBe(false)
  })
})

describe('F12 删除运行中后台会话：残留清理与晚到不复活（验收3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().currentProject = { id: 'proj-1', name: '项目一', files: [] } as never
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
    deleteAgentSession.mockReset().mockResolvedValue(undefined)
    useToast().toasts.value.splice(0)
  })

  /** 预置乙的各类残留标记（运行中 + 待确认 + 保存失败 + 最近变更） */
  function seedResidues(store: ReturnType<typeof useChatStore>) {
    seedActiveSession(store)
    emitEvent({ type: 'run-start', runId: 'run-乙-1', sessionId: '乙' })
    emitEvent({
      type: 'confirmation-required',
      sessionId: '乙',
      request: { id: 'cf-乙', targetPath: 'chapters/a.txt', diff: { kind: 'edit', path: 'chapters/a.txt', oldText: '旧', newText: '新' } } as never,
    })
    emitEvent({
      type: 'session-save-failed',
      sessionId: '乙',
      projectId: 'proj-1',
      reason: 'io',
      message: '写入会话文件失败',
    })
    emitEvent({
      type: 'file-changed',
      projectId: 'proj-1',
      sessionId: '乙',
      file: {
        id: 'r-乙',
        change: { type: 'updated', path: 'chapters/a.txt' },
        coords: null,
        diff: null,
      } as never,
    })
  }

  it('删除后：运行标记/待确认/保存失败/最近变更全部清空', async () => {
    const store = useChatStore()
    seedResidues(store)

    await store.deleteSession('proj-1', '乙')

    expect(store.runningSessionIds.has('乙')).toBe(false)
    expect(store.pendingConfirmationsBySession.has('乙')).toBe(false)
    expect(store.sessionSaveFailures.size).toBe(0)
    expect(store.recentFileChanges).toHaveLength(0)
    expect(store.sessions.some((s) => s.sessionId === '乙')).toBe(false)
    // 甲的现场不动
    expect(store.activeSessionId).toBe('甲')
  })

  it('删除后晚到的 run-start / confirmation-required / file-changed 不得复活任何标记', async () => {
    const store = useChatStore()
    seedResidues(store)
    await store.deleteSession('proj-1', '乙')

    emitEvent({ type: 'run-start', runId: 'run-乙-2', sessionId: '乙' })
    emitEvent({
      type: 'confirmation-required',
      sessionId: '乙',
      request: { id: 'cf-乙-2', targetPath: 'chapters/a.txt', diff: { kind: 'edit', path: 'chapters/a.txt', oldText: '旧', newText: '新' } } as never,
    })
    emitEvent({
      type: 'file-changed',
      projectId: 'proj-1',
      sessionId: '乙',
      file: {
        id: 'r-乙-2',
        change: { type: 'updated', path: 'chapters/a.txt' },
        coords: null,
        diff: null,
      } as never,
    })

    expect(store.runningSessionIds.has('乙')).toBe(false)
    expect(store.pendingConfirmationsBySession.has('乙')).toBe(false)
    expect(store.recentFileChanges).toHaveLength(0)
    expect(store.sessions.some((s) => s.sessionId === '乙')).toBe(false)
  })

  it('删除的是激活会话：残留同样清理，并切到剩余列表第一条', async () => {
    const store = useChatStore()
    seedActiveSession(store)
    emitEvent({ type: 'run-start', runId: 'run-甲-1', sessionId: '甲' })

    getAgentSession.mockResolvedValue(fakeView('乙'))
    await store.deleteSession('proj-1', '甲')

    expect(store.runningSessionIds.has('甲')).toBe(false)
    expect(store.sessions.some((s) => s.sessionId === '甲')).toBe(false)
    expect(store.activeSessionId).toBe('乙')
  })
})

describe('跨项目反馈隔离返修', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().currentProject = { id: 'proj-2', name: '项目二', files: [] } as never
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
  })

  it('旧项目文件变更与保存失败不进入新项目通知', () => {
    const store = useChatStore()
    seedActiveSession(store)
    emitEvent({
      type: 'file-changed', projectId: 'proj-1', sessionId: '乙',
      file: { id: 'old', change: { type: 'updated', path: 'chapters/a.txt' }, coords: null, diff: null } as never,
    })
    emitEvent({ type: 'session-save-failed', projectId: 'proj-1', sessionId: '乙', reason: 'io', message: '旧项目失败' })
    expect(store.recentFileChanges).toHaveLength(0)
    expect(store.sessionSaveFailures.size).toBe(0)
  })

  it('旧项目新建会话晚到：不抢占现场，也不把旧项目摘要插入新列表', async () => {
    const store = useChatStore()
    store.activeSessionId = 'new'
    store.sessionView = fakeView('new', 'proj-2')
    store.sessions = [{ sessionId: 'new', title: '新项目', updatedAt: '2' }] as never
    let releaseOld!: (value: ChatSessionView) => void
    createAgentSession.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
    const creating = store.createNewSession('proj-1', { skipReload: true })
    createAgentSession.mockResolvedValue(fakeView('new', 'proj-2'))
    await store.initSessions('proj-2')
    releaseOld(fakeView('old', 'proj-1'))
    await creating

    expect(store.activeSessionId).toBe('new')
    expect(store.sessions.map((item) => item.sessionId)).toEqual(['new'])
  })

  it('旧项目列表读取晚于新项目列表：最终只保留新项目摘要', async () => {
    getAgentSession.mockResolvedValue(fakeView('new', 'proj-2'))
    createAgentSession.mockResolvedValue(fakeView('new', 'proj-2'))
    const store = useChatStore()
    const newProject = { id: 'proj-2', name: '项目二', files: [] } as never
    useProjectStore().currentProject = newProject
    store.sessionView = fakeView('new', 'proj-2')
    store.activeSessionId = 'new'
    // 独立列表刷新场景只建立项目归属，不创建或切换会话。
    store.setSessionProjectForTest('proj-2')
    let releaseOld!: (value: never) => void
    listAgentSessions.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
    useProjectStore().currentProject = { id: 'proj-1', name: '项目一', files: [] } as never
    const oldLoad = store.loadSessions('proj-1')
    useProjectStore().currentProject = { id: 'proj-2', name: '项目二', files: [] } as never
    listAgentSessions.mockResolvedValueOnce([{ sessionId: 'new', title: '新项目', updatedAt: '2' }] as never)
    await store.loadSessions('proj-2')
    releaseOld([{ sessionId: 'old', title: '旧项目', updatedAt: '1' }] as never)
    await oldLoad
    expect(store.sessions.map((item) => item.sessionId)).toEqual(['new'])
  })
})

describe('F11 保存失败与进入现场（错误持续性出口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().currentProject = { id: 'proj-1', name: '项目一', files: [] } as never
    getAgentSession.mockReset()
    createAgentSession.mockReset()
    listAgentSessions.mockReset().mockResolvedValue([])
    isAgentRunActive.mockReset().mockReturnValue(false)
  })

  it('selectSession 进入乙现场：乙的保存失败记录清除，甲的保留', async () => {
    const store = useChatStore()
    seedActiveSession(store)
    emitEvent({
      type: 'session-save-failed',
      sessionId: '乙',
      projectId: 'proj-1',
      reason: 'io',
      message: '写入会话文件失败',
    })
    emitEvent({
      type: 'session-save-failed',
      sessionId: '丙',
      projectId: 'proj-1',
      reason: 'io',
      message: '另一份失败',
    })
    expect(store.sessionSaveFailures.size).toBe(2)

    getAgentSession.mockResolvedValue(fakeView('乙'))
    await store.selectSession('proj-1', '乙')

    expect(store.sessionSaveFailures.has('乙')).toBe(false)
    expect(store.sessionSaveFailures.has('丙')).toBe(true)
  })
})
