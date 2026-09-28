import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatSession, runChatDriver, _getActiveChatDriverCountForTest } from './session'
import { enqueueToInbox } from './inbox'
import type { ChatSessionState } from '../../types/chat'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * driver 全链路集成测试：driver（session.ts）→ turn 层（query.ts）→ step 层（溢出重试）全真实，
 * 仅 stub 掉 fetch（模拟 OpenAI SSE 流）与 agent-log（不落盘）。
 *
 * 覆盖 W2 门禁手动场景的可自动化部分：
 * - 长任务不再被 8 轮打断（agentMaxTurns 默认 0 = 不限）
 * - 停止后队列保留、不自动续跑
 * - followup 接续（真实 query 透传）
 * （「压缩与插话同框先抽干后压缩」的调用序断言在 query.test.ts，这里不重复。）
 */

vi.mock('../logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test`,
  writeAgentLog: vi.fn(),
}))

const stubProject = {
  id: 'proj-test',
  name: '测试项目',
  // ReadFile 在空调用柄上必抛错 → 工具结果 ok:false 回灌模型，循环照常继续（本测试只关心循环结构）
  handle: {},
} as unknown as ProjectSnapshot

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    // agentMaxTurns 缺省：走 DEFAULT_MAX_TURNS = 0 = 不限
  },
} as unknown as ProjectConfig

type FetchCall = { messages: Array<{ role: string; content?: string | null }> }

let fetchCalls: FetchCall[] = []
let fetchHandler: (call: FetchCall, index: number) => Response

function sseResponse(lines: string[]): Response {
  const text = lines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 一整块返回工具调用（arguments 一次给全，collectToolCallDeltas 累积后 finalize 出完整调用）。 */
function toolCallSse(id: string, name: string, args: Record<string, unknown>): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls',
      }],
    }),
  ])
}

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
  ])
}

/** reasoning_content 增量 + 正文增量（deepseek-reasoner 风格）：思考先于正文。 */
function reasoningTextSse(reasoning: string, text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }),
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
  ])
}

/** 思考后直接调工具（无正文）：reasoning-only assistant 轮。 */
function reasoningToolCallSse(reasoning: string, id: string, name: string, args: Record<string, unknown>): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }),
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls',
      }],
    }),
  ])
}

beforeEach(() => {
  fetchCalls = []
  fetchHandler = () => textSse('默认回答')
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const call: FetchCall = { messages: JSON.parse(init?.body ?? '{}').messages ?? [] }
    fetchCalls.push(call)
    return fetchHandler(call, fetchCalls.length - 1)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
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

/** session 层事件类型（runChatDriver onEvent 参数，从签名推导避免导出测试专用类型）。 */
type SessionEvent = Parameters<NonNullable<Parameters<typeof runChatDriver>[0]['onEvent']>>[0]

function isOf<T extends SessionEvent['type']>(type: T) {
  return (event: SessionEvent): event is Extract<SessionEvent, { type: T }> => event.type === type
}

describe('driver 全链路（真实 query + 假 SSE）', () => {
  it('长任务不被 8 轮打断：agentMaxTurns 缺省 0 = 不限，12 个工具回合后正常收尾', async () => {
    fetchHandler = (_call, index) =>
      index < 12
        ? toolCallSse(`call_${index}`, 'ReadFile', { path: 'chapters/001.txt' })
        : textSse('全部读完，收尾')

    const result = await runChatDriver({
      session: createSessionWithQueue(['通读全部章节并总结']),
      input: { ...driverInput, instruction: '' },
    })

    // 12 次工具回合 + 1 次收尾 = 13 次模型调用（旧默认 8 会在第 8 轮被砍断）
    expect(fetchCalls).toHaveLength(13)
    // 无轮次上限提示
    const summaries = result.session.messages.filter((m) => m.kind === 'context-summary')
    expect(summaries.some((m) => m.kind === 'context-summary' && m.summary.includes('最大循环次数'))).toBe(false)
    // 正常收尾
    expect(result.session.status).toBe('waiting-user')
    expect(result.session.inbox).toEqual({ nextTurn: [], nextStep: [] })
    const lastAssistant = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'assistant').at(-1)
    expect(lastAssistant).toMatchObject({ text: '全部读完，收尾' })
    expect(_getActiveChatDriverCountForTest()).toBe(0)
  })

  it('停止保队列：流式期间 abort → 当前 turn 优雅收尾，剩余 followup 不自动续跑', async () => {
    const userStop = new AbortController()

    // 第一次调用挂起流（首块给半个 delta，第二块永不返回），并在流式期间触发用户停止
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const call: FetchCall = { messages: JSON.parse(init?.body ?? '{}').messages ?? [] }
      fetchCalls.push(call)
      const firstChunk = new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '写到一半' } }] })}\n\n`,
      )
      let reads = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          reads += 1
          if (reads === 1) {
            controller.enqueue(firstChunk)
            // 首块已交付：等流式循环处理完并挂到下一次 read 的 abort 监听上再停（宏任务余量充足）
            setTimeout(() => userStop.abort(), 30)
            return
          }
          // 第二块永不给出；等调用方信号把 readStreamChunk 的 race 打断
          await new Promise(() => {})
        },
      })
      return new Response(stream, { status: 200 })
    }))

    const result = await runChatDriver({
      session: createSessionWithQueue(['第一条', '第二条', '第三条']),
      input: { ...driverInput, instruction: '', signal: userStop.signal },
    })

    // 只跑了一个 turn：剩余两条留在收件箱，不自动续跑
    expect(fetchCalls).toHaveLength(1)
    expect(result.session.inbox?.nextTurn.map((m) => m.text)).toEqual(['第二条', '第三条'])
    // 优雅收尾：半截内容保留为 assistant 消息 + change-summary 带已停止标记（本轮无改动，UI 渲染降级行）
    const assistantTexts = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'assistant')
    expect(assistantTexts.some((m) => m.kind === 'text' && m.text === '写到一半')).toBe(true)
    const changeSummaries = result.session.messages.filter((m) => m.kind === 'change-summary')
    expect(changeSummaries).toHaveLength(1)
    expect(changeSummaries[0]).toMatchObject({ aborted: true })
    expect(result.session.status).toBe('waiting-user')
    expect(_getActiveChatDriverCountForTest()).toBe(0)
  })

  it('followup 接续：第一条跑完后第二条自动开新 turn，模型看到各自指令', async () => {
    fetchHandler = (_call, index) => textSse(index === 0 ? '第一章已写' : '第二章已写')

    const result = await runChatDriver({
      session: createSessionWithQueue(['写第一章', '写第二章']),
      input: { ...driverInput, instruction: '' },
    })

    expect(fetchCalls).toHaveLength(2)
    // 第二个 turn 的请求里带着第二条的完整用户上下文（且包含第一轮的回答——视图跨 turn 延续）
    const secondTurnText = JSON.stringify(fetchCalls[1].messages)
    expect(secondTurnText).toContain('写第二章')
    expect(secondTurnText).toContain('第一章已写')

    const assistantTexts = result.session.messages
      .filter((m) => m.kind === 'text' && m.role === 'assistant')
      .map((m) => m.kind === 'text' && m.text)
    expect(assistantTexts).toEqual(['第一章已写', '第二章已写'])
    expect(result.session.inbox).toEqual({ nextTurn: [], nextStep: [] })
  })

  it('每条 followup 用自己的入队快照解析当前文件，不被唤醒时兜底快照覆盖', async () => {
    fetchHandler = (_call, index) => textSse(index === 0 ? '按第一章处理' : '按第二章处理')

    let session = createChatSession('proj-test')
    for (const [text, file] of [
      ['照这个写第一章', 'chapters/001.txt'],
      ['照这个写第二章', 'chapters/002.txt'],
    ] as const) {
      const enqueued = enqueueToInbox(session.inbox, 'next-turn', { text, activeFilePath: file })
      session = { ...session, inbox: enqueued.state }
    }

    const result = await runChatDriver({
      session,
      // 唤醒兜底快照指向第三个文件：两条 followup 各带快照，轮不到它
      input: { ...driverInput, instruction: '', activeFilePath: 'chapters/999.txt' },
    })

    expect(fetchCalls).toHaveLength(2)
    expect(JSON.stringify(fetchCalls[0].messages)).toContain('chapters/001.txt')
    expect(JSON.stringify(fetchCalls[0].messages)).not.toContain('chapters/999.txt')
    // 第二轮请求延续第一轮上下文（含 001），但「默认目标」是自己的 002，兜底 999 始终不出现
    expect(JSON.stringify(fetchCalls[1].messages)).toContain('chapters/002.txt')
    expect(JSON.stringify(fetchCalls[1].messages)).not.toContain('chapters/999.txt')
    expect(result.session.inbox).toEqual({ nextTurn: [], nextStep: [] })
  })

  it('思考流全链路：reasoning delta 与正文共享 messageId，最终消息带 reasoning 落盘', async () => {
    fetchHandler = () => reasoningTextSse('我先想一想', '想好了')
    const events: SessionEvent[] = []
    const result = await runChatDriver({
      session: createSessionWithQueue(['写一句']),
      input: { ...driverInput, instruction: '' },
      onEvent: (event) => events.push(event),
    })

    const reasoningDeltas = events.filter(isOf('message-reasoning-delta'))
    const textDeltas = events.filter(isOf('message-delta'))
    expect(reasoningDeltas).toHaveLength(1)
    expect(reasoningDeltas[0].text).toBe('我先想一想')
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].text).toBe('想好了')
    // 思考与正文属于同一条 assistant 消息（UI 原位追加的前提）
    expect(reasoningDeltas[0].messageId).toBe(textDeltas[0].messageId)

    const assistantTexts = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'assistant')
    expect(assistantTexts).toHaveLength(1)
    expect(assistantTexts[0]).toMatchObject({ text: '想好了', reasoning: '我先想一想' })
    // 落盘消息复用流式占位 id（UI 原位替换的前提）
    expect(assistantTexts[0].id).toBe(reasoningDeltas[0].messageId)
  })

  it('思考后直接调工具：content 空但 reasoning 落一条气泡，思考随工具轮回传（DeepSeek 400 修复）', async () => {
    fetchHandler = (_call, index) =>
      index === 0
        ? reasoningToolCallSse('盘算一下', 'call_r', 'ReadFile', { path: 'chapters/001.txt' })
        : textSse('收尾')

    const result = await runChatDriver({
      session: createSessionWithQueue(['通读章节']),
      input: { ...driverInput, instruction: '' },
    })

    const assistantTexts = result.session.messages.filter((m) => m.kind === 'text' && m.role === 'assistant')
    expect(assistantTexts).toHaveLength(2)
    // 第一轮：思考后直接调工具，assistant 气瓶仅带 reasoning（text 空）
    expect(assistantTexts[0]).toMatchObject({ text: '', reasoning: '盘算一下' })
    // 第二轮收尾无思考：不带 reasoning 字段
    expect(assistantTexts[1]).toMatchObject({ text: '收尾' })
    expect('reasoning' in assistantTexts[1]).toBe(false)
    // 思考随历史回传：工具轮后的请求在 assistant 消息上带 reasoning_content（DeepSeek 思考模式硬要求）
    const secondRequestMessages = fetchCalls[1].messages as Array<Record<string, unknown>>
    const toolTurnAssistant = secondRequestMessages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    )
    expect(toolTurnAssistant).toMatchObject({ reasoning_content: '盘算一下' })
  })

  it('轮次安全阀：达 agentMaxTurns 上限时提示为 turn-limit kind，不再伪装 context-summary', async () => {
    fetchHandler = () => toolCallSse('call_limit', 'ReadFile', { path: 'chapters/001.txt' })

    const result = await runChatDriver({
      session: createSessionWithQueue(['通读全部章节']),
      input: {
        ...driverInput,
        instruction: '',
        config: { ...stubConfig, settings: { ...stubConfig.settings, agentMaxTurns: 1 } },
      },
    })

    // 1 个 step 即达上限：1 次模型调用后优雅收尾
    expect(fetchCalls).toHaveLength(1)
    const limitMessages = result.session.messages.filter((m) => m.kind === 'turn-limit')
    expect(limitMessages).toHaveLength(1)
    expect(limitMessages[0]).toMatchObject({ summary: expect.stringContaining('最大循环次数') })
    // 同文案不再出现在 context-summary 里（那会被 UI 折进任务组藏起来）
    expect(
      result.session.messages.some((m) => m.kind === 'context-summary' && m.summary.includes('最大循环次数')),
    ).toBe(false)
    expect(result.session.status).toBe('waiting-user')
  })
})
