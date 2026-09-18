import { describe, expect, it, vi, beforeEach } from 'vitest'

import { createChatSession, runChatDriver, runChatTurn, _getActiveChatDriverCountForTest } from './session'
import { enqueueToInbox } from './inbox'
import { query } from '../agent/query'
import type { AgentMessage } from '../agent/messages'
import type { ChatSessionState } from '../../types/chat'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

vi.mock('../agent/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/query')>()
  return {
    ...actual,
    query: vi.fn(),
  }
})

vi.mock('../logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test`,
  writeAgentLog: vi.fn(),
}))

const mockedQuery = vi.mocked(query)

const stubProject = {
  id: 'proj-test',
  name: '测试项目',
  handle: {},
} as unknown as ProjectSnapshot

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

describe('runChatTurn 流式 delta 转发', () => {
  it('同一批 delta 共享稳定 messageId，最终 assistant 落盘消息复用该 id', async () => {
    mockedQuery.mockImplementation(async (input) => {
      input.onEvent?.({ type: 'query-step-start', step: 1 })
      input.onEvent?.({ type: 'assistant-delta', text: '先读' })
      input.onEvent?.({ type: 'assistant-delta', text: '文件' })
      const first: AgentMessage = { role: 'assistant', content: '先读文件' }
      input.onEvent?.({ type: 'assistant-message', message: first })
      input.onEvent?.({ type: 'assistant-delta', text: '再改' })
      const second: AgentMessage = { role: 'assistant', content: '再改' }
      input.onEvent?.({ type: 'assistant-message', message: second })
      input.view.messages = [...input.view.messages, first, second]
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const events: Array<{ type: string; messageId?: string; text?: string; message?: { id: string; kind: string; text?: string } }> = []
    const result = await runChatTurn({
      session: createChatSession('proj-test'),
      input: {
        instruction: '改一下第一章',
        project: stubProject,
        config: stubConfig,
        systemPrompt: '系统提示',
      },
      onEvent: (event) => events.push(event),
    })

    const deltas = events.filter((event) => event.type === 'message-delta')
    expect(deltas).toHaveLength(3)
    // 前两个 delta 同属一条 assistant 消息，第三个属于下一条
    expect(deltas[0].messageId).toBeTruthy()
    expect(deltas[1].messageId).toBe(deltas[0].messageId)
    expect(deltas[2].messageId).toBeTruthy()
    expect(deltas[2].messageId).not.toBe(deltas[0].messageId)

    // 落盘的 assistant 文本消息复用 delta 的 messageId，UI 才能原位替换占位气泡
    const assistantTexts = result.session.messages.filter(
      (message) => message.kind === 'text' && message.role === 'assistant',
    )
    expect(assistantTexts.map((message) => message.id)).toEqual([
      deltas[0].messageId,
      deltas[2].messageId,
    ])
    expect(assistantTexts.map((message) => 'text' in message && message.text)).toEqual(['先读文件', '再改'])
  })
})

describe('runChatTurn 上下文压缩联动', () => {
  it('context-compacted 事件在显示层追加 context-summary 提示，模型视图落盘', async () => {
    mockedQuery.mockImplementation(async (input) => {
      input.onEvent?.({
        type: 'context-compacted',
        compactedMessageCount: 6,
        originalTokens: 9000,
        summaryTokens: 400,
      })
      input.view.messages = [
        ...input.view.messages.slice(0, 1),
        { role: 'user', content: '<compacted-summary>摘要</compacted-summary>' },
      ]
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const result = await runChatTurn({
      session: createChatSession('proj-test'),
      input: {
        instruction: '继续写',
        project: stubProject,
        config: stubConfig,
        systemPrompt: '系统提示',
      },
    })

    const summaries = result.session.messages.filter((message) => message.kind === 'context-summary')
    // 两条开场提示（本轮目标 + 任务类型）+ 1 条压缩提示
    expect(summaries).toHaveLength(3)
    expect(summaries[2].summary).toContain('压缩 6 条')
    expect(summaries[2].summary).toContain('9000')
    // 模型视图持久化为压缩后的样子
    expect(result.session.modelView?.messages).toHaveLength(2)
    expect(result.session.modelView?.messages[1].content).toContain('<compacted-summary>')
  })
})

describe('runChatDriver 分层循环（driver 层）', () => {
  beforeEach(() => {
    mockedQuery.mockReset()
  })

  function createSessionWithQueue(queueTexts: string[]): ChatSessionState {
    let session = createChatSession('proj-test')
    for (const text of queueTexts) {
      const enqueued = enqueueToInbox(session.inbox, 'next-turn', { text })
      session = { ...session, inbox: enqueued.state }
    }
    return session
  }

  const driverInput = {
    project: stubProject,
    config: stubConfig,
    systemPrompt: '系统提示',
  } as const

  it('followup 接续：两条排队消息各占一个 turn，query 跑两次，首批顺序 FIFO', async () => {
    const seenInstructions: string[] = []
    mockedQuery.mockImplementation(async (input) => {
      // 记录每个 turn 模型视图里的最后一条 user 消息（首批 followup 注入的用户上下文）
      const lastUser = [...input.view.messages].reverse().find((m) => m.role === 'user')
      seenInstructions.push(lastUser?.content ?? '')
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const result = await runChatDriver({
      session: createSessionWithQueue(['先写第一章', '再写第二章']),
      input: { ...driverInput, instruction: '' },
    })

    expect(mockedQuery).toHaveBeenCalledTimes(2)
    // FIFO：先「先写第一章」后「再写第二章」
    expect(seenInstructions[0]).toContain('先写第一章')
    expect(seenInstructions[1]).toContain('再写第二章')

    // 显示层：两条普通 user 气泡（各是任务组边界），无 steering 标记
    const userBubbles = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'user')
    expect(userBubbles.map((m) => 'text' in m && m.text)).toEqual(['先写第一章', '再写第二章'])
    expect(userBubbles.every((m) => !('steered' in m && m.steered))).toBe(true)

    // 每 turn 两条 context-summary：两个 turn 共 4 条
    expect(result.session.messages.filter((m) => m.kind === 'context-summary')).toHaveLength(4)
    // 收件箱已抽干；闩锁已清
    expect(result.session.inbox).toEqual({ nextTurn: [], nextStep: [] })
    expect(_getActiveChatDriverCountForTest()).toBe(0)
    expect(result.session.status).toBe('waiting-user')
  })

  it('停止保队列：abort 后当前 turn 优雅收尾，剩余队列保留不自动续跑', async () => {
    mockedQuery.mockImplementation(async (input) => {
      input.onEvent?.({ type: 'aborted', reason: 'user' })
      input.onEvent?.({ type: 'done', messages: input.view.messages, aborted: true })
      return input.view.messages
    })

    const result = await runChatDriver({
      session: createSessionWithQueue(['第一条', '第二条', '第三条']),
      input: { ...driverInput, instruction: '' },
    })

    // 只跑了一个 turn 就收敛：剩余两条留在收件箱，不自动续跑
    expect(mockedQuery).toHaveBeenCalledTimes(1)
    expect(result.session.inbox?.nextTurn.map((m) => m.text)).toEqual(['第二条', '第三条'])
    expect(result.session.status).toBe('waiting-user')
    expect(_getActiveChatDriverCountForTest()).toBe(0)
    // 停止的 turn 有「已被停止」收尾摘要
    const summaries = result.session.messages.filter((m) => m.kind === 'action-summary')
    expect(summaries.at(-1)?.summary).toContain('已被用户停止')
  })

  it('首批顺序：steer 全量在前、followup 在后；steer 气泡带 steered 标记且包装进模型视图', async () => {
    let session = createChatSession('proj-test')
    const steer1 = enqueueToInbox(session.inbox, 'next-step', { text: '插话一' })
    session = { ...session, inbox: steer1.state }
    const steer2 = enqueueToInbox(session.inbox, 'next-step', { text: '插话二' })
    session = { ...session, inbox: steer2.state }
    const follow = enqueueToInbox(session.inbox, 'next-turn', { text: '正式任务' })
    session = { ...session, inbox: follow.state }

    let turnViewMessages: AgentMessage[] = []
    mockedQuery.mockImplementation(async (input) => {
      turnViewMessages = [...input.view.messages]
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const result = await runChatDriver({
      session,
      input: { ...driverInput, instruction: '' },
    })

    // 显示层顺序：插话一 → 插话二 → 正式任务（批次内先 steer 后 followup）
    const userBubbles = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'user')
    expect(userBubbles.map((m) => 'text' in m && m.text)).toEqual(['插话一', '插话二', '正式任务'])
    // steer 气泡带 steered 标记（分组规则用）；followup 不带
    expect(userBubbles[0]).toMatchObject({ steered: true })
    expect(userBubbles[1]).toMatchObject({ steered: true })
    expect(userBubbles[2]).not.toMatchObject({ steered: true })

    // 模型视图顺序一致：steer 用插话包装，followup 用完整用户上下文
    const viewUser = turnViewMessages.filter((m) => m.role === 'user').map((m) => m.content)
    expect(viewUser[0]).toContain('用户插话')
    expect(viewUser[0]).toContain('插话一')
    expect(viewUser[1]).toContain('插话二')
    expect(viewUser[2]).toContain('正式任务')
    expect(viewUser[2]).not.toContain('用户插话')
  })

  it('query 抽干点取到的插话：steering-message 事件补显示层气泡', async () => {
    mockedQuery.mockImplementation(async (input) => {
      // 模拟 query 在 step 边界抽到一条运行中插话
      input.onEvent?.({
        type: 'steering-message',
        message: { id: 'q-mid', text: '运行中插一句', at: '2026-09-19T10:00:00.000Z' },
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const result = await runChatDriver({
      session: createSessionWithQueue(['主任务']),
      input: { ...driverInput, instruction: '' },
    })

    const steered = result.session.messages.filter(
      (m) => m.kind === 'text' && m.role === 'user' && 'steered' in m && m.steered,
    )
    expect(steered).toHaveLength(1)
    expect(steered[0]).toMatchObject({ text: '运行中插一句' })
  })
})
