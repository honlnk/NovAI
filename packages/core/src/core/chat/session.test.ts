import { describe, expect, it, vi } from 'vitest'

import { createChatSession, refreshSystemMessageContent, runChatTurn } from './session'
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

describe('refreshSystemMessageContent', () => {
  it('replaces the system message content at index 0', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: '旧 system prompt' },
      { role: 'user', content: '用户第一条' },
      { role: 'assistant', content: '助手回复' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system prompt')

    expect(result[0]).toEqual({ role: 'system', content: '新 system prompt' })
    // 后续消息原样保留
    expect(result[1]).toEqual({ role: 'user', content: '用户第一条' })
    expect(result[2]).toEqual({ role: 'assistant', content: '助手回复' })
    expect(result).toHaveLength(3)
  })

  it('does not mutate the original array (returns new array)', () => {
    const original: AgentMessage[] = [
      { role: 'system', content: '旧' },
      { role: 'user', content: '用户' },
    ]

    const result = refreshSystemMessageContent(original, '新')

    expect(original[0].content).toBe('旧') // 原数组不变
    expect(result).not.toBe(original) // 返回新数组
    expect(result[0].content).toBe('新')
  })

  it('returns messages as-is when index 0 is not a system message', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '首条不是 system' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system prompt')

    expect(result).toBe(messages)
  })

  it('returns empty array as-is', () => {
    expect(refreshSystemMessageContent([], '新')).toEqual([])
  })

  it('preserves tool-call assistant messages after the system message', () => {
    // 模拟真实 Agent Loop 产生的消息序列：system, user, assistant(toolCalls), tool(result)
    const messages: AgentMessage[] = [
      { role: 'system', content: '旧' },
      { role: 'user', content: '读一下文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'ReadFile', content: '文件内容' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system')

    expect(result[0].content).toBe('新 system')
    // tool call / tool result 结构完整保留
    expect(result[2].role).toBe('assistant')
    expect(result[3].role).toBe('tool')
    expect((result[2] as { toolCalls?: unknown }).toolCalls).toHaveLength(1)
  })
})

describe('runChatTurn 流式 delta 转发', () => {
  const stubProject = {
    id: 'proj-test',
    name: '测试项目',
    handle: {},
  } as unknown as ProjectSnapshot

  const stubConfig = {
    llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
    settings: { enableDebugLogging: false },
  } as unknown as ProjectConfig

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
      const messages: AgentMessage[] = [...input.messages, first, second]
      input.onEvent?.({ type: 'done', messages })
      return messages
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
