import { beforeEach, describe, expect, it, vi } from 'vitest'

import { query, type AgentQueryEvent } from './query'
import { AgentAbortedError, streamAgentCompletion } from './llm'
import type { AgentMessage } from './messages'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>()
  return {
    ...actual,
    streamAgentCompletion: vi.fn(),
  }
})

const mockedStream = vi.mocked(streamAgentCompletion)

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: { enableDebugLogging: false },
} as unknown as ProjectConfig

const stubProject = { handle: {} } as unknown as ProjectSnapshot

const baseMessages: AgentMessage[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '介绍一下这个项目' },
]

function collectEvents(): { events: AgentQueryEvent[]; onEvent: (event: AgentQueryEvent) => void } {
  const events: AgentQueryEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('query assistant-delta 转发', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  it('forwards stream deltas as assistant-delta events, then the final assistant message', async () => {
    mockedStream.mockImplementation(async (_input, onEvent) => {
      onEvent({ type: 'start' })
      onEvent({ type: 'delta', text: '这是' })
      onEvent({ type: 'delta', text: '一个项目' })
      return { content: '这是一个项目', toolCalls: [], finishReason: 'stop' }
    })

    const { events, onEvent } = collectEvents()
    const messages = await query({
      config: stubConfig,
      project: stubProject,
      messages: baseMessages,
      tools: {},
      onEvent,
    })

    const deltas = events.filter((event) => event.type === 'assistant-delta')
    expect(deltas).toEqual([
      { type: 'assistant-delta', text: '这是' },
      { type: 'assistant-delta', text: '一个项目' },
    ])

    // 最终完整文本仍由 assistant-message 事件落盘，delta 只是瞬态渲染态
    const assistantMessages = events.filter((event) => event.type === 'assistant-message')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({ message: { content: '这是一个项目' } })

    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: '这是一个项目', toolCalls: [] })
  })

  it('emits no assistant-delta when the stream produces only tool calls', async () => {
    mockedStream.mockImplementation(async () => ({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
    }))

    const { events, onEvent } = collectEvents()
    await query({
      config: stubConfig,
      project: stubProject,
      messages: baseMessages,
      tools: {},
      onEvent,
    })

    expect(events.filter((event) => event.type === 'assistant-delta')).toHaveLength(0)
  })

  it('keeps already-streamed partial content as the final assistant message on abort', async () => {
    mockedStream.mockImplementation(async (_input, onEvent) => {
      onEvent({ type: 'delta', text: '已生成一半' })
      throw new AgentAbortedError('已生成一半')
    })

    const { events, onEvent } = collectEvents()
    const messages = await query({
      config: stubConfig,
      project: stubProject,
      messages: baseMessages,
      tools: {},
      onEvent,
    })

    // UI 上已显示的 delta 与最终落盘的 partialContent 一致
    expect(events).toContainEqual({ type: 'assistant-delta', text: '已生成一半' })
    const assistantMessages = events.filter((event) => event.type === 'assistant-message')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({ message: { content: '已生成一半' } })
    expect(events).toContainEqual({ type: 'aborted', reason: 'user', partialContent: '已生成一半' })
    expect(events.at(-1)).toMatchObject({ type: 'done', aborted: true })
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: '已生成一半' })
  })
})
