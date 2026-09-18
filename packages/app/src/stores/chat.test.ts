import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AgentUiEvent, ChatSessionView } from '@novai/core/services/types'

import {
  createSession,
  getSession,
  listSessions,
  runTurn,
} from '@novai/core/services/agent-service'
import { useChatStore } from './chat'

vi.mock('@novai/core/services/agent-service', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  runTurn: vi.fn(),
  respondConfirmation: vi.fn(),
}))

const mockedCreateSession = vi.mocked(createSession)
const mockedGetSession = vi.mocked(getSession)
const mockedListSessions = vi.mocked(listSessions)
const mockedRunTurn = vi.mocked(runTurn)

function createSessionView(sessionId: string): ChatSessionView {
  return {
    sessionId,
    projectId: 'project-1',
    status: 'idle',
    messages: [],
    title: '新对话',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

describe('chat store message-delta 路由', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockedListSessions.mockResolvedValue([])
  })

  it('旧会话残留的流式 delta 不写进当前会话视图（跨会话串扰防护）', async () => {
    const store = useChatStore()
    const view = createSessionView('session-current')
    mockedCreateSession.mockResolvedValue(view)
    await store.createNewSession('project-1', { skipReload: true })

    // 捕获 runTurn 的 onEvent，模拟服务层在运行期间推送事件
    let emit: (event: AgentUiEvent) => void = () => {}
    mockedRunTurn.mockImplementation(async (input) => {
      emit = input.onEvent ?? (() => {})
      return {
        projectId: 'project-1',
        sessionId: 'session-current',
        changedFiles: [],
        session: { ...view, status: 'waiting-user' as const },
      }
    })
    await store.runServiceTurn({ projectId: 'project-1', instruction: '写一段开头' })

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
})
