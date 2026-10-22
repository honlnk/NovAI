import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatSession, runChatDriver } from './session'
import { enqueueToInbox } from './inbox'
import { AGENT_ROLES } from '../agent/roles'
import type { ChatSessionState } from '../../types/chat'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 直聊会话装配测试（角色机制 W2）：以要素管理员角色驱动 runChatDriver，
 * 验证按会话角色的装配差异——system 用角色声明、ELEMENT.md 恒注入、用户消息裸文本、
 * 不注入 NovAI/大纲、工具面白名单（无委派工具）、工具事件/改动账本带 agent 归属。
 * 全链只 stub fetch（SSE 编排）与 agent-log（不落盘），query/装配/工具执行全真实。
 */

vi.mock('../logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test`,
  writeAgentLog: vi.fn(),
}))

const ELEMENT_SCHEMA_CONTENT = '# 要素规范\n一人一文件，文件名即要素名。'

/** 假项目句柄：支持 prompts/ELEMENT.md 读取（约束文档注入路径）。 */
const stubProject = {
  id: 'proj-direct-chat',
  name: '直聊测试项目',
  config: {} as ProjectConfig,
  handle: {
    async getDirectoryHandle(name: string) {
      if (name !== 'prompts') {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      return {
        async getFileHandle(fileName: string) {
          if (fileName !== 'ELEMENT.md') {
            throw new DOMException(`Not found: ${fileName}`, 'NotFoundError')
          }
          return {
            kind: 'file',
            name: fileName,
            async getFile() {
              return new File([ELEMENT_SCHEMA_CONTENT], fileName, { type: 'text/markdown' })
            },
          }
        },
      }
    },
  },
} as unknown as ProjectSnapshot

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
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

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
  ])
}

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

function buildTurnInput() {
  return {
    instruction: '',
    project: stubProject,
    config: stubConfig,
    systemPrompt: '',
    // 故意给上项目记忆与大纲（角色声明应拒收——要素管理员不注入）
    novaiOverview: '# 项目记忆\n主角是个哑巴',
    outline: { path: 'prompts/outlines/主线.md', content: '# 大纲\n第一卷' },
    activeFilePath: null,
  }
}

function createDirectChatSession(): ChatSessionState {
  const session = createChatSession('proj-direct-chat', { agent: 'element-manager' })
  const enqueued = enqueueToInbox(session.inbox, 'next-turn', { text: '整理整个要素库' })
  session.inbox = enqueued.state
  return session
}

describe('直聊会话装配（角色机制 W2）', () => {
  it('会话创建带角色字段；缺省会话归主角色', () => {
    expect(createDirectChatSession().agent).toBe('element-manager')
    expect(createChatSession('proj-direct-chat').agent).toBe('main')
  })

  it('首轮装配：要素管理员 system + ELEMENT.md 恒注入 + 用户消息裸文本 + 不注入 NovAI/大纲', async () => {
    await runChatDriver({
      session: createDirectChatSession(),
      input: buildTurnInput(),
    })

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)
    const messages = fetchCalls[0]!.messages
    const system = messages.find((message) => message.role === 'system')?.content ?? ''

    // system：要素管理员角色声明（含身份句与五段分层），不是主角色 prompt
    expect(system).toContain('NovAI 要素管理员')
    expect(system).not.toContain('你是 NovAI，一个使用')
    expect(system).toBe(AGENT_ROLES['element-manager'].buildSystemPrompt({ model: 'model' }))

    // ELEMENT.md reminder：system 之后、先于用户消息
    const userContents = messages.filter((message) => message.role === 'user').map((m) => m.content)
    expect(userContents.length).toBeGreaterThanOrEqual(2)
    expect(userContents[0]).toContain('<system-reminder>')
    expect(userContents[0]).toContain(ELEMENT_SCHEMA_CONTENT)

    // 用户消息裸文本：不带主角色用户上下文包装（「用户意图：」/「当前项目：」）
    const lastUser = userContents[userContents.length - 1]!
    expect(lastUser).toBe('整理整个要素库')
    expect(lastUser).not.toContain('用户意图：')

    // 不注入 NovAI 项目记忆与大纲（reminder 特征句不出现；结构段提及目录名词不算）
    const allText = messages.map((message) => message.content ?? '').join('\n')
    expect(allText).not.toContain('以下是项目级记忆')
    expect(allText).not.toContain('以下是当前写作大纲')
    expect(allText).not.toContain('主角是个哑巴')
    expect(allText).not.toContain('第一卷')
  })

  it('工具面白名单：模型误调委派工具回灌失败（未注册），白名单内工具正常执行并带 agent 归属', async () => {
    fetchHandler = (call, index) => {
      if (index === 0) {
        return toolCallSse('call-1', 'ReadFile', { path: 'elements/characters/主角.md' })
      }
      if (index === 1) {
        return toolCallSse('call-2', 'DelegateToElementManager', { task: '再委派一次' })
      }
      return textSse('汇报完成')
    }

    const session = createDirectChatSession()
    await runChatDriver({ session, input: buildTurnInput() })

    // 白名单内工具：真实执行（空调用柄读文件失败 → ok:false 结果回灌，消息行带角色归属）
    const readCall = session.messages.find(
      (message) => message.kind === 'tool-call' && message.toolName === 'ReadFile',
    )
    expect(readCall?.agent).toBe('element-manager')
    const readResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'ReadFile',
    )
    expect(readResult?.agent).toBe('element-manager')

    // 委派工具不在要素管理员工具面：模型误调收到失败回灌（防递归）
    const delegateResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'DelegateToElementManager',
    )
    expect(delegateResult?.ok).toBe(false)
  })

  it('多轮续聊：modelView 持久化生效，ELEMENT.md reminder 不重复注入', async () => {
    fetchHandler = () => textSse('收到')

    const session = createDirectChatSession()
    await runChatDriver({ session, input: buildTurnInput() })

    // 第二轮追问：同会话再入队 + 重新驱动
    const second = enqueueToInbox(session.inbox, 'next-turn', { text: '为什么合并 A 和 B？' })
    session.inbox = second.state
    await runChatDriver({ session, input: buildTurnInput() })

    const secondRoundMessages = fetchCalls[fetchCalls.length - 1]!.messages
    const reminderMessages = secondRoundMessages.filter(
      (message) => message.role === 'user' && message.content.includes('要素规范'),
    )
    // 恒为唯一一条（digest 去重，不随轮次累积）
    expect(reminderMessages).toHaveLength(1)
    // 第一轮的用户消息与回答仍在视图中（上下文延续）
    const allText = secondRoundMessages.map((message) => message.content ?? '').join('\n')
    expect(allText).toContain('整理整个要素库')
    expect(allText).toContain('收到')
    expect(allText).toContain('为什么合并 A 和 B？')
  })
})
