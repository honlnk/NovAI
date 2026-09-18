import { beforeEach, describe, expect, it, vi } from 'vitest'

import { query, type AgentQueryEvent } from './query'
import { AgentAbortedError, streamAgentCompletion } from './llm'
import { createModelView, type ModelView } from './model-view'
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

function createStubConfig(overrides: { conversationTokenLimit?: number } = {}): ProjectConfig {
  return {
    llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
    settings: {
      enableDebugLogging: false,
      conversationTokenLimit: overrides.conversationTokenLimit ?? 12000,
      compressionKeepRecentTurns: 5,
      agentMaxTurns: 8,
    },
  } as unknown as ProjectConfig
}

const stubProject = { handle: {} } as unknown as ProjectSnapshot

function createBaseView(): ModelView {
  return createModelView([
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '介绍一下这个项目' },
  ])
}

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
    const view = createBaseView()
    const messages = await query({
      config: createStubConfig(),
      project: stubProject,
      view,
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
    // 视图同步更新（模型层唯一来源）
    expect(view.messages.at(-1)).toEqual({ role: 'assistant', content: '这是一个项目', toolCalls: [] })
  })

  it('emits no assistant-delta when the stream produces only tool calls', async () => {
    mockedStream.mockImplementation(async () => ({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
    }))

    const { events, onEvent } = collectEvents()
    await query({
      config: createStubConfig(),
      project: stubProject,
      view: createBaseView(),
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
    const view = createBaseView()
    const messages = await query({
      config: createStubConfig(),
      project: stubProject,
      view,
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

describe('query 上下文压缩接入', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  function createHeavyView(): ModelView {
    // 足够长：总 token 明显超过 300 的阈值，且有可压区间
    const messages: AgentMessage[] = [
      { role: 'system', content: '系统提示' },
      ...Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? { role: 'user' as const, content: '用户长消息'.repeat(20) }
          : { role: 'assistant' as const, content: '助手长回复'.repeat(20) }),
    ]
    return createModelView(messages)
  }

  it('压力触发：请求前超过阈值先压缩，再发真实请求', async () => {
    const summaryResponse = { content: '## Primary Request and Intent\n写小说', toolCalls: [], finishReason: 'stop' }
    const realResponse = { content: '好的，继续', toolCalls: [], finishReason: 'stop' }
    const calls: Array<{ toolCount: number; lastMessageIsInstruction: boolean }> = []
    mockedStream.mockImplementation(async (input) => {
      calls.push({
        toolCount: input.tools.length,
        lastMessageIsInstruction: input.messages.at(-1)?.content.includes('检查点') ?? false,
      })
      // 第一次调用是压缩（末条为压缩指令、无 tools），第二次是真实请求
      return calls.length === 1 ? summaryResponse : realResponse
    })

    const { events, onEvent } = collectEvents()
    const view = createHeavyView()
    const messagesBefore = view.messages.length
    await query({
      config: createStubConfig({ conversationTokenLimit: 300 }),
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    // 第一次调用是压缩请求（无 tools、末条为压缩指令）
    expect(calls[0]).toEqual({ toolCount: 0, lastMessageIsInstruction: true })
    // 压缩事件已发（显示层据此提示用户）
    expect(events).toContainEqual({
      type: 'context-compacted',
      compactedMessageCount: expect.any(Number),
      originalTokens: expect.any(Number),
      summaryTokens: expect.any(Number),
    })
    // 视图收缩：system + 摘要 + 后续 assistant 输出
    expect(view.messages.length).toBeLessThan(messagesBefore + 1)
    expect(view.messages[1].content).toContain('<compacted-summary>')
    // system 提示仍在头部
    expect(view.messages[0].role).toBe('system')
  })

  it('未达阈值时不压缩，直接发真实请求', async () => {
    mockedStream.mockResolvedValue({ content: '直接回答', toolCalls: [], finishReason: 'stop' })

    const { events, onEvent } = collectEvents()
    const view = createBaseView()
    await query({
      config: createStubConfig({ conversationTokenLimit: 12000 }),
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    expect(mockedStream).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'context-compacted')).toHaveLength(0)
  })

  it('溢出触发：context 超限错误 → 强制压缩一次 → 重试请求成功', async () => {
    const summaryResponse = { content: '## Critical Context\n要点', toolCalls: [], finishReason: 'stop' }
    const realResponse = { content: '重试成功', toolCalls: [], finishReason: 'stop' }
    let call = 0
    mockedStream.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        throw new Error("This model's maximum context length is 4096 tokens")
      }
      if (call === 2) {
        return summaryResponse // 压缩调用
      }
      return realResponse // 重试的真实请求
    })

    const { events, onEvent } = collectEvents()
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '一'.repeat(1000) },
      { role: 'assistant', content: '二'.repeat(1000) },
      { role: 'user', content: '三'.repeat(1000) },
      { role: 'assistant', content: '四'.repeat(1000) },
    ])
    const result = await query({
      config: createStubConfig({ conversationTokenLimit: 12000 }),
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    // 三次调用：失败 → 压缩 → 重试
    expect(mockedStream).toHaveBeenCalledTimes(3)
    expect(events.filter((event) => event.type === 'context-compacted')).toHaveLength(1)
    expect(result.at(-1)).toMatchObject({ role: 'assistant', content: '重试成功' })
    expect(view.messages[1].content).toContain('<compacted-summary>')
  })

  it('溢出后压缩失败（无可压区间）时原样抛错', async () => {
    let call = 0
    mockedStream.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        throw new Error('context window exceeded')
      }
      // 第二次（压缩）也失败
      throw new Error('压缩调用失败')
    })

    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '只有一轮' },
    ])

    await expect(query({
      config: createStubConfig({ conversationTokenLimit: 12000 }),
      project: stubProject,
      view,
      tools: {},
    })).rejects.toThrow('context window exceeded')
  })
})

describe('query 压缩期停止归类（abort 不误报为 error）', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  it('压力触发的压缩期用户停止：归类 aborted + done，不上抛 error', async () => {
    // 摘要调用（第一个调用，末条为压缩指令）期间用户点停止
    mockedStream.mockImplementation(async (input) => {
      const isCompaction = input.messages.at(-1)?.content.includes('检查点') ?? false
      if (isCompaction) {
        throw new AgentAbortedError('半截摘要')
      }
      return { content: '不应到达', toolCalls: [], finishReason: 'stop' }
    })

    const { events, onEvent } = collectEvents()
    const view = createModelView([
      { role: 'system', content: '系统提示' },
      ...Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? { role: 'user' as const, content: '用户长消息'.repeat(20) }
          : { role: 'assistant' as const, content: '助手长回复'.repeat(20) }),
    ])

    // 不 reject：停止是正常退出路径
    const messages = await query({
      config: createStubConfig({ conversationTokenLimit: 300 }),
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    expect(events).toContainEqual({ type: 'aborted', reason: 'user' })
    expect(events.at(-1)).toMatchObject({ type: 'done', aborted: true })
    // 压缩摘要的半截内容不是用户内容，不落盘
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('半截摘要'))).toBe(false)
    // 真实请求未发出（在压缩阶段就停了）
    expect(mockedStream).toHaveBeenCalledTimes(1)
  })

  it('溢出重试的压缩期用户停止：同样归类 aborted + done，不上抛 error', async () => {
    let call = 0
    mockedStream.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        throw new Error('Range of input length should be [1, 30720]') // 百炼溢出文案
      }
      throw new AgentAbortedError('') // 压缩调用期间用户停止
    })

    const { events, onEvent } = collectEvents()
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '一'.repeat(1000) },
      { role: 'assistant', content: '二'.repeat(1000) },
      { role: 'user', content: '三'.repeat(1000) },
    ])

    const messages = await query({
      config: createStubConfig({ conversationTokenLimit: 12000 }),
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    expect(events).toContainEqual({ type: 'aborted', reason: 'user' })
    expect(events.at(-1)).toMatchObject({ type: 'done', aborted: true })
    expect(messages.some((m) => m.content.includes('compacted-summary'))).toBe(false)
  })
})

describe('query 轮次上限', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  it('轮次从 config.settings.agentMaxTurns 读取；超限优雅收尾（事件提示而非死话术，可续接）', async () => {
    // 每轮都返回一个工具调用，驱动循环直到触顶
    mockedStream.mockImplementation(async () => ({
      content: '',
      toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'chapters/001.txt' } }],
      finishReason: 'tool_calls',
    }))

    const { events, onEvent } = collectEvents()
    const view = createBaseView()
    const messages = await query({
      config: { ...createStubConfig(), settings: { ...createStubConfig().settings, agentMaxTurns: 2 } },
      project: stubProject,
      view,
      tools: {},
      onEvent,
    })

    // 模型调用次数 = agentMaxTurns
    expect(mockedStream).toHaveBeenCalledTimes(2)
    // 优雅收尾事件而非硬编码 assistant 话术
    expect(events).toContainEqual({ type: 'turn-limit-reached', maxTurns: 2 })
    const limitAssistantMessages = events.filter(
      (event) => event.type === 'assistant-message' && event.message.content.includes('最大循环次数'),
    )
    expect(limitAssistantMessages).toHaveLength(0)
    // 模型视图保留完整上下文（末尾停在工具结果），用户可继续发消息续接
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('agentMaxTurns = 0 时不限轮次：循环只靠结局/停止收敛', async () => {
    // 前 4 轮都返回工具调用（超过旧默认 8 的语义验证用 4 轮即可，关键是阀门不触发）
    let call = 0
    mockedStream.mockImplementation(async () => {
      call += 1
      if (call <= 4) {
        return {
          content: '',
          toolCalls: [{ id: `call_${call}`, name: 'ReadFile', input: { path: 'chapters/001.txt' } }],
          finishReason: 'tool_calls',
        }
      }
      return { content: '完成', toolCalls: [], finishReason: 'stop' }
    })

    const { events, onEvent } = collectEvents()
    const messages = await query({
      config: { ...createStubConfig(), settings: { ...createStubConfig().settings, agentMaxTurns: 0 } },
      project: stubProject,
      view: createBaseView(),
      tools: {},
      onEvent,
    })

    expect(mockedStream).toHaveBeenCalledTimes(5)
    expect(events.filter((event) => event.type === 'turn-limit-reached')).toHaveLength(0)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '完成' })
  })
})

describe('query 插话（steering）', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  function createSteering(queue: Array<{ id: string; text: string; quote?: string; at: string }>) {
    return {
      drain: vi.fn(() => queue.splice(0, queue.length)),
      hasPending: vi.fn(() => queue.length > 0),
    }
  }

  it('抽干点：插话包装后进模型视图，发 steering-message 事件', async () => {
    mockedStream.mockResolvedValue({ content: '收到插话', toolCalls: [], finishReason: 'stop' })

    const queue = [
      { id: 'q1', text: '顺便把第二章也改了', at: '2026-09-19T10:00:00.000Z' },
      { id: 'q2', text: '引用这段', quote: '被引用的原文', at: '2026-09-19T10:00:01.000Z' },
    ]
    const steering = createSteering(queue)

    const { events, onEvent } = collectEvents()
    const view = createBaseView()
    await query({
      config: createStubConfig(),
      project: stubProject,
      view,
      tools: {},
      steering,
      onEvent,
    })

    // 两条插话都整批抽干
    expect(steering.drain).toHaveBeenCalled()
    const steeringEvents = events.filter((event) => event.type === 'steering-message')
    expect(steeringEvents).toHaveLength(2)

    // 模型视图含包装后的插话（标注执行中插话；quote 附带引用块）
    const contents = view.messages.map((m) => m.content)
    expect(contents.some((c) => c.includes('用户插话') && c.includes('顺便把第二章也改了'))).toBe(true)
    const quoted = contents.find((c) => c.includes('引用这段'))
    expect(quoted).toContain('用户引用的内容：')
    expect(quoted).toContain('被引用的原文')
  })

  it('steer 续命：无工具结局时 nextStep 非空 → turn 不闭合，下一抽干点取到后继续跑', async () => {
    const queue: Array<{ id: string; text: string; at: string }> = []
    let call = 0
    mockedStream.mockImplementation(async () => {
      call += 1
      if (call === 1) {
        // 第一轮流式期间用户发送插话（运行中入队）
        queue.push({ id: 'q1', text: '改主意了，先写第三章', at: '2026-09-19T10:00:00.000Z' })
        return { content: '第一轮回答', toolCalls: [], finishReason: 'stop' }
      }
      return { content: '响应插话', toolCalls: [], finishReason: 'stop' }
    })

    // 首轮抽干为空；第一轮结局时队列里已有 1 条插话
    const steering = {
      drain: vi.fn(() => queue.splice(0, queue.length)),
      hasPending: vi.fn(() => queue.length > 0),
    }

    const { events, onEvent } = collectEvents()
    const view = createBaseView()
    const messages = await query({
      config: createStubConfig(),
      project: stubProject,
      view,
      tools: {},
      steering,
      onEvent,
    })

    // 模型被调两次：结局未闭合，插话续了一个 step
    expect(mockedStream).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({
      type: 'steering-message',
      message: expect.objectContaining({ id: 'q1', text: '改主意了，先写第三章' }),
    })
    // done 只发一次（最终结局），且之前没有提前 done
    const doneIndices = events.map((e, i) => (e.type === 'done' ? i : -1)).filter((i) => i >= 0)
    expect(doneIndices).toEqual([events.length - 1])
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '响应插话' })
  })

  it('抽干先于压缩：同帧时先 drain 再发压缩请求（调用顺序固定）', async () => {
    const summaryResponse = { content: '## Critical Context\n要点', toolCalls: [], finishReason: 'stop' }
    const realResponse = { content: '继续', toolCalls: [], finishReason: 'stop' }
    const calls: Array<{ isCompaction: boolean }> = []
    mockedStream.mockImplementation(async (input) => {
      const isCompaction = input.messages.at(-1)?.content.includes('检查点') ?? false
      calls.push({ isCompaction })
      return isCompaction ? summaryResponse : realResponse
    })

    const steering = createSteering([
      { id: 'q1', text: '压缩前插进来', at: '2026-09-19T10:00:00.000Z' },
    ])

    const view = createModelView([
      { role: 'system', content: '系统提示' },
      ...Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? { role: 'user' as const, content: '用户长消息'.repeat(20) }
          : { role: 'assistant' as const, content: '助手长回复'.repeat(20) }),
    ])

    await query({
      config: createStubConfig({ conversationTokenLimit: 300 }),
      project: stubProject,
      view,
      tools: {},
      steering,
    })

    // 压缩确实发生了（第一次调用 = 压缩请求）
    expect(calls[0]).toEqual({ isCompaction: true })
    // 抽干的调用序号在压缩请求之前 → 先抽干后压缩
    expect((steering.drain as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(mockedStream.mock.invocationCallOrder[0])
    // 插话已进模型视图（压缩保留近端消息，视图尾部含插话）
    expect(view.messages.some((m) => m.content.includes('压缩前插进来'))).toBe(true)
  })
})
