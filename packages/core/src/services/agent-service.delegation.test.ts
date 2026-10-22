import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  getSession,
  listSessions,
  respondConfirmation,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent, RunAgentTurnResult } from './types'

/**
 * 委派会话化（角色机制 W3）service 层端到端：
 * 主会话的 DelegateToElementManager → delegationSessionRunner 创建要素管理员真会话
 * （落盘 + session-created 广播，不抢激活位）→ 独立模型请求（角色化 system + 白名单
 * 工具面 + 任务入队首条用户消息 + 覆盖配置合成）→ 汇报摘要回灌主 Agent，
 * 完整过程留在委派会话。委派会话的写确认走自己的会话确认链（confirmation-required /
 * confirmations-updated 携委派 sessionId，不穿透主会话）。
 *
 * 全链只 stub fetch（SSE 编排）；session/driver/委派工具/确认链/配置合成全真实。
 * 文件系统用内存 handle（会话落盘/提示词读取/真实写文件走它）。
 */

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-delegation-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

const REPORT = '## 改动文件清单\n\n- elements/characters/角色甲.md（新建）\n## 合并与迁移说明\n\n无\n## 存疑事项\n\n无\n## 建议删除\n\n无'

// ---------- fetch stub（SSE 编排） ----------

type FetchCall = {
  url: string
  model: string
  messages: Array<{ role: string; content?: string | null }>
  toolNames: string[]
  /** 是否委派会话的请求（按 system 里的要素管理员身份段判定） */
  isDelegation: boolean
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

/**
 * fetch 分流：主会话第 1 次调委派工具、之后转述；委派会话按测试需要出招
 * （mainSecondResponse 之外的编排由各用例经 delegationHandler 定制）。
 */
let delegationHandler: (callIndex: number) => Response

beforeEach(() => {
  fetchCalls = []
  mainCallIndex = 0
  delegationHandler = () => textSse(REPORT)
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const system = String((body.messages ?? []).find((m: { role: string }) => m.role === 'system')?.content ?? '')
    const isDelegation = system.includes('你是 NovAI 要素管理员')
    const call: FetchCall = {
      url: String(url),
      model: body.model ?? '',
      messages: body.messages ?? [],
      toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
      isDelegation,
    }
    fetchCalls.push(call)

    if (isDelegation) {
      return delegationHandler(fetchCalls.filter((c) => c.isDelegation).length - 1)
    }
    // 主会话：第 1 次请求委派工具，之后基于工具结果转述
    if (mainCallIndex === 0) {
      mainCallIndex += 1
      return toolCallSse('t-main-1', 'DelegateToElementManager', {
        task: '整理第 12 章新增人物',
        scope: 'elements/characters/',
      })
    }
    return textSse('已收到汇报，向用户转述要点。')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- 内存文件系统 fixture（照 agent-service.change-ledger.test.ts） ----------

const stubConfig = {
  project: { name: 'Delegation Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://main.example.com/v1', apiKey: 'main-key', model: 'main-model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
  elementManager: {
    llm: {
      baseUrl: 'https://em.example.com/v1',
      apiKey: 'em-key',
      model: 'em-model',
      protocol: 'openai',
    },
  },
} as unknown as ProjectConfig

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md；ELEMENT.md 供要素管理员 reminder 注入
  seedFile(handle, 'prompts/system.md', '系统提示')
  seedFile(handle, 'prompts/ELEMENT.md', '# 测试要素规范\n\n一人一文件。')
  return {
    id: 'proj-delegate',
    name: 'Delegation Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-delegate',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

function seedFile(root: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()!
  let current = root.__entry
  for (const segment of segments) {
    let next = current.entries.get(segment)
    if (!next) {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }
    if (next.kind !== 'directory') throw new Error(`fixture 冲突：${segment}`)
    current = next
  }
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({ kind: 'directory', name, entries: new Map() })
}

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

/** 项目根 entry（读回真实写入的文件用）。 */
let projectRoot: MemoryDirectoryHandle

// ---------- 用例 ----------

/**
 * 发一条主会话消息并等主会话收敛；收全程事件流。
 * onEvent 允许用例对事件流即时反应（如响应确认卡）。
 */
async function runMainTurn(onEvent?: (event: AgentUiEvent) => void) {
  const events: AgentUiEvent[] = []
  const finished = new Promise<RunAgentTurnResult>((resolve, reject) => {
    const unsubscribe = subscribeAgentEvents((event) => {
      events.push(event)
      onEvent?.(event)
      if (event.type === 'run-finish' && event.sessionId === mainSessionId) {
        unsubscribe()
        resolve(event.result)
      }
      if (event.type === 'run-error' && event.sessionId === mainSessionId) {
        unsubscribe()
        reject(new Error(event.error.message))
      }
    })
  })
  await enqueueMessage({ projectId: 'proj-delegate', text: '帮我管理一下要素', mode: 'queue' })
  const result = await finished
  return { result, events }
}

let mainSessionId = ''

describe('委派会话化（service 层端到端）', () => {
  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    projectRoot = buildProject().handle as MemoryDirectoryHandle
    setRuntimeProject({
      ...buildProject(),
      handle: projectRoot,
    })
    const main = await createSession('proj-delegate')
    mainSessionId = main.sessionId
  })

  it('委派全链路：真会话创建（session-created + 列表 + 不抢激活位）→ 覆盖配置合成 → 汇报回灌主 Agent', async () => {
    const { result, events } = await runMainTurn()

    // 模型请求分流：主会话打主档、委派会话打覆盖档（mergeConfig 在委派路径同样生效）
    const delegationCalls = fetchCalls.filter((call) => call.isDelegation)
    const mainCalls = fetchCalls.filter((call) => !call.isDelegation)
    expect(delegationCalls).toHaveLength(1)
    expect(mainCalls).toHaveLength(2)
    expect(delegationCalls[0]!.url).toBe('https://em.example.com/v1/chat/completions')
    expect(delegationCalls[0]!.model).toBe('em-model')
    expect(mainCalls.every((call) => call.url === 'https://main.example.com/v1/chat/completions' && call.model === 'main-model')).toBe(true)

    // 委派会话装配：system 身份段含覆盖模型名；工具面白名单（无委派工具，防递归）；
    // 首条 user 是 ELEMENT.md reminder，末条 user 是任务文本（任务/范围自包含）
    const system = String(delegationCalls[0]!.messages.find((m) => m.role === 'system')?.content)
    expect(system).toContain('使用 em-model 模型驱动的子智能体')
    expect(system).not.toContain('# 测试要素规范')
    expect(delegationCalls[0]!.toolNames.sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile', 'RenameFile'],
    )
    const userMessages = delegationCalls[0]!.messages.filter((m) => m.role === 'user')
    expect(userMessages[0]?.content).toContain('以下是本书要素规范（prompts/ELEMENT.md）')
    expect(userMessages[userMessages.length - 1]?.content).toContain('管理任务：整理第 12 章新增人物')
    expect(userMessages[userMessages.length - 1]?.content).toContain('管理范围：elements/characters/')

    // 主 Agent 第 2 次请求的上下文里有委派工具结果：汇报全文 + 会话句柄
    const toolMessages = mainCalls[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.content).toContain('要素管理完成')
    expect(toolMessages[0]!.content).toContain('角色甲.md（新建）')
    expect(toolMessages[0]!.content).toContain('完整过程保存在要素管理员会话')

    // 事件流：委派会话创建广播 + 自己的 run-start/run-finish
    const created = events.find((event) => event.type === 'session-created')
    expect(created).toMatchObject({ projectId: 'proj-delegate' })
    const delegationSessionId = created && created.type === 'session-created' ? created.sessionId : ''
    expect(delegationSessionId).toBeTruthy()
    expect(events.some((event) => event.type === 'run-start' && event.sessionId === delegationSessionId)).toBe(true)
    expect(events.some((event) => event.type === 'run-finish' && event.sessionId === delegationSessionId)).toBe(true)

    // 会话列表：两个会话，委派会话按角色标记、标题取任务首句；激活位仍在主会话
    const sessions = await listSessions('proj-delegate')
    expect(sessions).toHaveLength(2)
    const delegationSummary = sessions.find((s) => s.agent === 'element-manager')
    expect(delegationSummary?.title).toBe('整理第 12 章新增人物')
    const active = await getSession('proj-delegate')
    expect(active?.sessionId).toBe(mainSessionId)

    // 委派会话内容：首条用户消息是任务文本，最后一条 assistant 是汇报全文
    const delegationView = await getSession('proj-delegate', delegationSessionId)
    expect(delegationView?.agent).toBe('element-manager')
    const delegationTexts = delegationView?.messages.filter((m) => m.kind === 'text') ?? []
    expect(delegationTexts[0]).toMatchObject({ role: 'user', text: expect.stringContaining('管理任务：整理第 12 章新增人物') })
    expect(delegationTexts[delegationTexts.length - 1]).toMatchObject({ role: 'assistant', text: REPORT })

    // 主会话收尾：最后一条 assistant 是转述
    const lastMainText = [...(result.session.messages ?? [])].reverse().find((m) => m.kind === 'text' && m.role === 'assistant')
    expect(lastMainText).toMatchObject({ text: '已收到汇报，向用户转述要点。' })
  })

  it('确认链按会话路由：委派会话的写确认带角色标签与委派 sessionId，respond 后放行真实写入', async () => {
    delegationHandler = (callIndex) => {
      if (callIndex === 0) {
        // CreateFile 是结构操作：默认档（chapter-material）也要确认
        return toolCallSse('t-em-1', 'CreateFile', {
          path: 'elements/characters/角色甲.md',
          content: '---\nname: 角色甲\n---\n',
        })
      }
      return textSse(REPORT)
    }

    const confirmationsUpdated: AgentUiEvent[] = []
    const { events } = await runMainTurn((event) => {
      if (event.type === 'confirmations-updated') {
        confirmationsUpdated.push(event)
      }
      // 接受确认卡（模拟用户在委派会话里点了允许）；推迟到微任务——
      // 注册侧还有 confirmations-updated(1 张) 快照要广播，同步 respond 会抢跑把它吞掉
      if (event.type === 'confirmation-required') {
        const confirmationId = event.request.id
        queueMicrotask(() => respondConfirmation(confirmationId, true))
      }
    })

    // 确认卡归属委派会话（不穿透主会话），带「要素管理员」标签
    const required = events.find((event) => event.type === 'confirmation-required')
    expect(required).toBeDefined()
    const delegationSessionId = required && required.type === 'confirmation-required' ? required.sessionId : ''
    expect(delegationSessionId).not.toBe(mainSessionId)
    expect(required && required.type === 'confirmation-required' ? required.request.agentLabel : undefined)
      .toBe('要素管理员')

    // 快照广播：注册时 1 张、resolve 后清空（徽标据此熄灭）
    const snapshots = confirmationsUpdated.filter(
      (event) => event.type === 'confirmations-updated' && event.sessionId === delegationSessionId,
    )
    expect(snapshots.some((event) => event.type === 'confirmations-updated' && event.confirmations.length === 1)).toBe(true)
    const last = snapshots[snapshots.length - 1]
    expect(last && last.type === 'confirmations-updated' ? last.confirmations.length : -1).toBe(0)

    // 确认放行后真实写入发生，账本记录带 agent 归属
    const delegationView = await getSession('proj-delegate', delegationSessionId)
    const ledger = (delegationView?.changedFiles ?? [])
    expect(ledger.some((file) => 'path' in file && file.path === 'elements/characters/角色甲.md')).toBe(true)
    const written = readSeededFile('elements/characters/角色甲.md')
    expect(written).toContain('name: 角色甲')
  })
})

/** 从内存项目根读回真实写入的文件内容；文件不存在返回 null。 */
function readSeededFile(path: string): string | null {
  let current: MemoryEntry = projectRoot.__entry
  for (const segment of path.split('/').filter(Boolean)) {
    const next = current.kind === 'directory' ? current.entries.get(segment) : undefined
    if (!next) {
      return null
    }
    current = next
  }
  return current.kind === 'file' ? current.content : null
}
