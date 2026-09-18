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
})
