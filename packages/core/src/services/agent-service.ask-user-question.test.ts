import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  getSession,
  listSessions,
  respondQuestion,
  skipQuestion,
  stopAgentRun,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent, AskUserQuestionRequestView, RunAgentTurnResult } from './types'

/**
 * 主动提问工具（《Agent 主动提问工具计划》第一阶段）service 层端到端：
 * 主会话的 AskUserQuestion → question-required 广播 + 提问卡落消息流 → 等待期间
 * Agent Loop 挂起在工具内 → UI 调 respondQuestion/skipQuestion → 答案作为工具结果
 * 回灌 → 原任务继续到收敛。覆盖单选、多选、纯文本、选择与文本并存、跳过、停止、
 * 重复回答、切换会话后答案路由、错误会话回答与事件顺序。
 *
 * 全链只 stub fetch（SSE 编排），工具/会话/驱动/提问注册表全真实（照 delegation 测试）。
 */

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-ask-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

// ---------- fetch stub（SSE 编排） ----------

type FetchCall = {
  messages: Array<{ role: string; content?: string | null }>
  toolNames: string[]
}

let fetchCalls: FetchCall[] = []
let mainCallIndex = 0

function sseResponse(lines: string[]): Response {
  const text = lines.map((line) => `data: ${line}\n\n`).join('\n') + 'data: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
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

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
  ])
}

/** 主会话出招编排：第 1 次调提问工具，之后每次 textSse（个别用例经 mainSecondResponse 定制）。 */
let mainSecondResponse: () => Response = () => textSse('已收到回答，继续推进任务。')

beforeEach(() => {
  fetchCalls = []
  mainCallIndex = 0
  mainSecondResponse = () => textSse('已收到回答，继续推进任务。')
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const call: FetchCall = {
      messages: body.messages ?? [],
      toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
    }
    fetchCalls.push(call)

    if (mainCallIndex === 0) {
      mainCallIndex += 1
      return toolCallSse('q-call-1', 'AskUserQuestion', {
        question: '第 12 章结尾主角选择哪条路？',
        header: '剧情方向',
        options: [
          { label: '北上寻师', description: '开启修行线' },
          { label: '留下守城', description: '开启守战线' },
        ],
      })
    }
    return mainSecondResponse()
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- 内存文件系统 fixture（照 delegation 测试） ----------

const stubConfig = {
  project: { name: 'Ask Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://main.example.com/v1', apiKey: 'key', model: 'main-model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createDirectoryHandle(entry: MemoryDirectoryEntry): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') return createDirectoryHandle(current)
      if (current) throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') return createFileHandle(current)
      if (current) throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, { type: 'text/plain', lastModified: entry.lastModified })
    },
    async createWritable() {
      let nextContent = ''
      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob ? await data.text() : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function buildProject(): ProjectSnapshot {
  const handle = createDirectoryHandle({ kind: 'directory', name: 'novel', entries: new Map() })
  // readSystemPrompt 不容缺省
  ;(handle.__entry.entries.get('prompts') as MemoryDirectoryEntry | undefined)?.entries.set(
    'system.md',
    { kind: 'file', name: 'system.md', content: '系统提示', lastModified: Date.now() },
  )
  const prompts = handle.__entry.entries.get('prompts')
  if (!prompts) {
    handle.__entry.entries.set('prompts', {
      kind: 'directory',
      name: 'prompts',
      entries: new Map([
        ['system.md', { kind: 'file', name: 'system.md', content: '系统提示', lastModified: Date.now() } as MemoryFileEntry],
      ]),
    })
  }
  return {
    id: 'proj-ask',
    name: 'Ask Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-ask',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

// ---------- 用例 ----------

/** 发一条主会话消息并等该会话收敛（run-finish / run-error 按 sessionId 过滤）；收全程事件流。 */
async function runMainTurn(onEvent?: (event: AgentUiEvent) => void, sessionId?: string) {
  const targetSessionId = sessionId ?? mainSessionId
  const events: AgentUiEvent[] = []
  const finished = new Promise<RunAgentTurnResult>((resolve, reject) => {
    const unsubscribe = subscribeAgentEvents((event) => {
      events.push(event)
      onEvent?.(event)
      if (event.type === 'run-finish' && event.sessionId === targetSessionId) {
        unsubscribe()
        resolve(event.result)
      }
      if (event.type === 'run-error' && event.sessionId === targetSessionId) {
        unsubscribe()
        reject(new Error(event.error.message))
      }
    })
  })
  await enqueueMessage({
    projectId: 'proj-ask',
    ...(sessionId ? { sessionId } : {}),
    text: '写第 12 章',
    mode: 'queue',
  })
  const result = await finished
  return { result, events }
}

let mainSessionId = ''

describe('主动提问工具（service 层端到端）', () => {
  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    setRuntimeProject(buildProject())
    const main = await createSession('proj-ask')
    mainSessionId = main.sessionId
  })

  it('提问 → 等待 → 单选回答 → 原任务继续（事件顺序 + 工具结果回灌）', async () => {
    let requested: AskUserQuestionRequestView | null = null
    let responded = false
    const { result, events } = await runMainTurn((event) => {
      if (event.type === 'question-required' && event.sessionId === mainSessionId) {
        requested = event.request
        if (!responded) {
          responded = true
          // 等一拍再回答，确保等待态真实存在（不在同一个同步栈里 resolve）
          queueMicrotask(() => {
            respondQuestion({ questionId: event.request.questionId, selectedLabels: ['北上寻师'], text: '' })
          })
        }
      }
    })

    // question-required 先于等待解除：上面的微任务在 fetch 下一次请求前执行
    expect(requested).toMatchObject({
      question: '第 12 章结尾主角选择哪条路？',
      header: '剧情方向',
    })
    expect(requested!.options).toEqual([
      { label: '北上寻师', description: '开启修行线' },
      { label: '留下守城', description: '开启守战线' },
    ])

    // 工具面包含提问工具
    expect(fetchCalls[0]!.toolNames).toContain('AskUserQuestion')

    // 第 2 次模型请求的上下文里有提问工具结果（答案回灌模型视图）
    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.content).toContain('北上寻师')
    expect(toolMessages[0]!.content).toContain('继续原任务')

    // 事件顺序：question-required 在 tool-call 之后、run-finish 之前；questions-updated 快照先非空后空
    const types = events.map((event) => event.type)
    expect(types.indexOf('question-required')).toBeGreaterThan(types.indexOf('tool-call'))
    expect(types.indexOf('run-finish')).toBeGreaterThan(types.indexOf('question-required'))
    const questionSnapshots = events.filter((event) => event.type === 'questions-updated')
    expect(questionSnapshots.some((event) => event.type === 'questions-updated' && event.questions.length === 1)).toBe(true)
    expect(questionSnapshots.at(-1)).toMatchObject({ type: 'questions-updated', questions: [] })

    // 提问卡消息：问题与答案都在消息流里（answer 补全、卡片只读）
    const card = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({
      kind: 'ask-user-question',
      question: '第 12 章结尾主角选择哪条路？',
      answer: { selectedLabels: ['北上寻师'], outcome: 'answered' },
    })

    // 普通工具行保留为过程记录
    expect(result.session.messages.some((m) => m.kind === 'tool-call' && m.toolName === 'AskUserQuestion')).toBe(true)
    expect(result.session.messages.some((m) => m.kind === 'tool-result' && m.toolName === 'AskUserQuestion')).toBe(true)
  })

  it('多选 + 补充文本并存：完整选择集合回灌，不丢项', async () => {
    // 重置第 1 次出招为多选提问
    mainCallIndex = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}')
      fetchCalls.push({ messages: body.messages ?? [], toolNames: body.tools ?? [] })
      if (mainCallIndex === 0) {
        mainCallIndex += 1
        return toolCallSse('q-call-2', 'AskUserQuestion', {
          question: '哪些人物要进第 12 章？',
          options: [
            { label: '林晚照' },
            { label: '沈砚' },
            { label: '阿禾' },
          ],
          multiSelect: true,
        })
      }
      return textSse('收到，三个角色都写进去。')
    }))

    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required') {
        queueMicrotask(() => {
          respondQuestion({
            questionId: event.request.questionId,
            selectedLabels: ['沈砚', '林晚照', '阿禾'],
            text: '林晚照只出场不说话',
          })
        })
      }
    })

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('沈砚、林晚照、阿禾')
    expect(toolMessages[0]!.content).toContain('林晚照只出场不说话')

    const card = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({
      multiSelect: true,
      answer: {
        selectedLabels: ['沈砚', '林晚照', '阿禾'],
        text: '林晚照只出场不说话',
        outcome: 'answered',
      },
    })
  })

  it('纯文本回答（不选候选项）：允许，工具结果只带补充说明', async () => {
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required') {
        queueMicrotask(() => {
          respondQuestion({
            questionId: event.request.questionId,
            selectedLabels: [],
            text: '让他两条路都不选，直接跳崖',
          })
        })
      }
    })

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('跳崖')
    expect(toolMessages[0]!.content).not.toContain('所选选项')

    const card = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({
      answer: { selectedLabels: [], text: '让他两条路都不选，直接跳崖', outcome: 'answered' },
    })
  })

  it('空回答被拒：不选也不填时 respondQuestion 抛错，等待不解除', async () => {
    const events: AgentUiEvent[] = []
    let answered = false
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required' && !answered) {
        queueMicrotask(() => {
          expect(() =>
            respondQuestion({ questionId: event.request.questionId, selectedLabels: [], text: '   ' }),
          ).toThrow('回答不能为空')
          respondQuestion({ questionId: event.request.questionId, selectedLabels: ['留下守城'], text: '' })
          answered = true
        })
      }
    })

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('留下守城')
    void events
    void result
  })

  it('候选项之外的标签被拒', async () => {
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required') {
        queueMicrotask(() => {
          expect(() =>
            respondQuestion({ questionId: event.request.questionId, selectedLabels: ['不存在的选项'], text: '' }),
          ).toThrow('候选项之外')
          respondQuestion({ questionId: event.request.questionId, selectedLabels: ['北上寻师'], text: '' })
        })
      }
    })
    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('北上寻师')
    void result
  })

  it('跳过问题：取消结局回灌，Agent 不获得答案继续', async () => {
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required') {
        queueMicrotask(() => skipQuestion(event.request.questionId))
      }
    })

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('用户跳过了这个问题')
    expect(toolMessages[0]!.content).toContain('在不获得该答案的情况下继续')

    const card = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({ answer: { outcome: 'cancelled', selectedLabels: [], text: '' } })
  })

  it('重复回答：第二次 respondQuestion 静默无效，不产生第二次工具结果', async () => {
    let firstQuestionId = ''
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required') {
        firstQuestionId = event.request.questionId
        queueMicrotask(() => {
          respondQuestion({ questionId: event.request.questionId, selectedLabels: ['北上寻师'], text: '' })
          // 收敛后再答一次：注册表已清空，静默返回
          respondQuestion({ questionId: event.request.questionId, selectedLabels: ['留下守城'], text: '' })
          skipQuestion(event.request.questionId)
        })
      }
    })

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.content).toContain('北上寻师')
    const card = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({ answer: { selectedLabels: ['北上寻师'] } })
    void firstQuestionId
  })

  it('停止运行：挂起提问按取消 resolve，本轮收尾且不再继续', async () => {
    const events: AgentUiEvent[] = []
    const stopped = new Promise<void>((resolve) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        events.push(event)
        if (event.type === 'question-required' && event.sessionId === mainSessionId) {
          queueMicrotask(() => stopAgentRun(mainSessionId))
        }
        if (event.type === 'run-finish' && event.sessionId === mainSessionId) {
          unsubscribe()
          resolve()
        }
      })
    })
    await enqueueMessage({ projectId: 'proj-ask', text: '写第 12 章', mode: 'queue' })
    await stopped

    // 工具结果 = 取消（跳过文案回灌模型，但本轮已停止不再发第 2 次模型请求）
    expect(fetchCalls).toHaveLength(1)
    // 提问卡无 answer（停止路径不补全），questions-updated 收敛为空快照
    const session = await getSession('proj-ask', mainSessionId)
    const card = session?.messages.find((m) => m.kind === 'ask-user-question')
    expect(card).toMatchObject({ kind: 'ask-user-question' })
    expect(card && 'answer' in card && card.answer).toBeFalsy()
    const snapshots = events.filter((event) => event.type === 'questions-updated')
    expect(snapshots.at(-1)).toMatchObject({ type: 'questions-updated', questions: [] })
    // 停止收尾：change-summary 带 aborted 标记
    expect(session?.messages.some((m) => m.kind === 'change-summary')).toBe(true)
  })

  it('切换会话后回答仍路由到原请求；错误会话的回答静默无效', async () => {
    // 另建一个会话模拟「切走了」，激活位切到新会话
    const other = await createSession('proj-ask')
    expect(other.sessionId).not.toBe(mainSessionId)

    // 显式发到原会话（问题发生在原会话，但激活位在别处——回答按 questionId 路由）
    const { result } = await runMainTurn((event) => {
      if (event.type === 'question-required' && event.sessionId === mainSessionId) {
        queueMicrotask(() => {
          respondQuestion({ questionId: event.request.questionId, selectedLabels: ['留下守城'], text: '守战线更好写' })
        })
      }
    }, mainSessionId)

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('留下守城')
    // 答案落在原会话的提问卡上，不落新会话
    const mainCard = result.session.messages.find((m) => m.kind === 'ask-user-question')
    expect(mainCard).toMatchObject({ answer: { selectedLabels: ['留下守城'] } })
    const otherView = await getSession('proj-ask', other.sessionId)
    expect(otherView?.messages.some((m) => m.kind === 'ask-user-question')).toBe(false)
  })

  it('非法参数回灌：空 question 的提问调用收到失败工具结果，会话不中断', async () => {
    mainCallIndex = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}')
      fetchCalls.push({ messages: body.messages ?? [], toolNames: body.tools ?? [] })
      if (mainCallIndex === 0) {
        mainCallIndex += 1
        return toolCallSse('q-call-3', 'AskUserQuestion', { question: '   ' })
      }
      return textSse('提问失败，我改用普通文字问用户：要往哪走？')
    }))

    const { result } = await runMainTurn()

    const toolMessages = fetchCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages[0]!.content).toContain('question 不能为空')
    // 非法参数不产生提问卡（工具校验在 tool-call 事件前拦截）
    expect(result.session.messages.some((m) => m.kind === 'ask-user-question')).toBe(false)
  })

  it('等待期间不自动超时：未回答时驱动保持挂起（不产生 run-finish）', async () => {
    let sawQuestion = false
    const race = await Promise.race([
      new Promise<'timeout'>(async (resolve) => {
        await new Promise((r) => setTimeout(r, 150))
        resolve('timeout')
      }),
      (async (): Promise<'finished'> => {
        await runMainTurn((event) => {
          if (event.type === 'question-required') {
            sawQuestion = true
          }
        })
        return 'finished'
      })(),
    ])
    expect(race).toBe('timeout')
    expect(sawQuestion).toBe(true)
    // 清理挂起的提问与驱动（按取消 resolve，避免泄漏到后续用例）
    stopAgentRun(mainSessionId)
  })
})

describe('主动提问：直聊与委派会话不装配该工具', () => {
  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    setRuntimeProject(buildProject())
  })

  it('要素管理员直聊会话的工具面没有 AskUserQuestion', async () => {
    const direct = await createSession('proj-ask', { agent: 'element-manager' })
    expect(direct.agent).toBe('element-manager')

    // 驱动一轮：直聊会话的模型请求工具面不含提问工具
    const finished = new Promise<void>((resolve, reject) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        if (event.type === 'run-finish' && event.sessionId === direct.sessionId) {
          unsubscribe()
          resolve()
        }
        if (event.type === 'run-error' && event.sessionId === direct.sessionId) {
          unsubscribe()
          reject(new Error(event.error.message))
        }
      })
    })
    await enqueueMessage({ projectId: 'proj-ask', sessionId: direct.sessionId, text: '整理要素', mode: 'queue' })
    await finished

    const emCall = fetchCalls.at(-1)!
    expect(emCall.toolNames).not.toContain('AskUserQuestion')
    expect(emCall.toolNames).not.toContain('DelegateToElementManager')
  })
})
