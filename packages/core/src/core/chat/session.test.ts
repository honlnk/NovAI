import { describe, expect, it, vi } from 'vitest'

import { createChatSession, runChatTurn } from './session'
import { query } from '../agent/query'
import type { AgentMessage } from '../agent/messages'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

vi.mock('../agent/query', () => ({
  query: vi.fn(),
}))

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
