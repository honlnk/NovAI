import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatSession, runChatDriver } from './session'
import { enqueueToInbox } from './inbox'
import type { ChatSessionState } from '../../types/chat'
import type { ProjectConfig, ProjectSnapshot, TreeNode } from '../../types/project'

/**
 * 技能目录会话接线测试（《技能包底层能力施工计划》阶段 2）：
 * 主角色注入技能目录 reminder（排在要素目录之后）且工具面含 LoadSkill；
 * 无技能项目视图干净、不写 digest；要素管理员不注入目录、工具面无 LoadSkill
 * （模型误调收到失败回灌）。全链只 stub fetch（SSE 编排）与 agent-log。
 */

vi.mock('../logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test`,
  writeAgentLog: vi.fn(),
}))

/* ---------- 内存文件系统（与 discovery 测试同款内联实现） ---------- */

type MemoryFileEntry = {
  kind: 'file'
  name: string
  content: string
  lastModified: number
}

type MemoryDirectoryEntry = {
  kind: 'directory'
  name: string
  entries: Map<string, MemoryEntry>
}

type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

type MemoryDirectoryHandle = FileSystemDirectoryHandle & {
  __entry: MemoryDirectoryEntry
}

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
      if (current?.kind === 'directory') {
        return createDirectoryHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') {
        return createFileHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
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
        async write(data: string) {
          nextContent += data
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 项目装配 ---------- */

let root: MemoryDirectoryHandle

function seedFile(path: string, content: string) {
  const segments = path.split('/')
  const fileName = segments.pop()!
  let current = root.__entry

  for (const segment of segments) {
    let next = current.entries.get(segment)
    if (!next || next.kind !== 'directory') {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }
    current = next
  }

  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

function project(withSkills: boolean): ProjectSnapshot {
  root = createMemoryDirectory('novel')
  // 要素：目录接线顺序断言的对照组（技能目录应排在要素目录之后）
  seedFile(
    'elements/characters/林晚.md',
    '---\nname: 林晚\ntype: character\nsummary: 冷静克制的外科医生\n---\n正文',
  )
  const tree: TreeNode[] = [
    { name: '林晚.md', path: 'elements/characters/林晚.md', kind: 'file' },
  ]
  if (withSkills) {
    seedFile(
      'skills/去AI味/SKILL.md',
      '---\ndescription: 降低 AI 腔的写作方法\nwhen_to_use: 写正文时用\n---\n\n# 去AI味方法\n避免排比堆叠。',
    )
    seedFile('skills/去AI味/references/词表.md', '词一\n词二')
  }

  return {
    id: 'proj-skill-wiring',
    name: '技能接线测试项目',
    rootName: 'novel',
    handle: root,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree,
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

type FetchCall = {
  messages: Array<{ role: string; content?: string | null }>
  toolNames: string[]
}

let fetchCalls: FetchCall[]
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
  fetchHandler = () => textSse('好的')
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const call: FetchCall = {
      messages: body.messages ?? [],
      toolNames: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
    }
    fetchCalls.push(call)
    return fetchHandler(call, fetchCalls.length - 1)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function buildTurnInput(withSkills: boolean) {
  return {
    instruction: '',
    project: project(withSkills),
    config: stubConfig,
    systemPrompt: '',
    activeFilePath: null,
  }
}

function createMainSession(): ChatSessionState {
  const session = createChatSession('proj-skill-wiring')
  const enqueued = enqueueToInbox(session.inbox, 'next-turn', { text: '写一段正文' })
  session.inbox = enqueued.state
  return session
}

function createElementManagerSession(): ChatSessionState {
  const session = createChatSession('proj-skill-wiring', { agent: 'element-manager' })
  seedFile('prompts/ELEMENT.md', '# 要素规范\n一人一文件。')
  const enqueued = enqueueToInbox(session.inbox, 'next-turn', { text: '整理要素库' })
  session.inbox = enqueued.state
  return session
}

describe('技能目录会话接线（阶段 2）', () => {
  it('主角色 + 有技能项目：技能目录注入（要素目录之后）、工具面含 LoadSkill、digest 落会话', async () => {
    const session = createMainSession()
    await runChatDriver({ session, input: buildTurnInput(true) })

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)
    const messages = fetchCalls[0]!.messages
    const userContents = messages.filter((message) => message.role === 'user').map((m) => m.content)

    // 技能目录 reminder：首注文案 + 技能行（name：description（when_to_use））
    const skillReminder = userContents.find((content) => content?.includes('<available_skills>'))
    expect(skillReminder).toBeTruthy()
    expect(skillReminder).toContain('以下是本项目已安装的写作技能')
    expect(skillReminder).toContain('- 去AI味：降低 AI 腔的写作方法（写正文时用）')

    // 排序：技能目录排在要素目录之后（决策 11：after-leading-reminders）
    const elementReminderIndex = userContents.findIndex((content) => content?.includes('<available_elements>'))
    const skillReminderIndex = userContents.findIndex((content) => content?.includes('<available_skills>'))
    expect(elementReminderIndex).toBeGreaterThanOrEqual(0)
    expect(skillReminderIndex).toBeGreaterThan(elementReminderIndex)
    // 都先于真实用户消息
    const userMessageIndex = userContents.findIndex((content) => content?.includes('用户意图：'))
    expect(userMessageIndex).toBeGreaterThan(skillReminderIndex)

    // 工具面：LoadSkill 已装配给主角色
    expect(fetchCalls[0]!.toolNames).toContain('LoadSkill')

    // digest 落会话（持久化字段）
    expect(session.skillCatalogDigest).toBeTruthy()
  })

  it('主角色 + 无技能项目：不注入目录、不写 digest，工具面照常含 LoadSkill', async () => {
    const session = createMainSession()
    await runChatDriver({ session, input: buildTurnInput(false) })

    const allText = fetchCalls[0]!.messages.map((message) => message.content ?? '').join('\n')
    expect(allText).not.toContain('<available_skills>')
    expect(allText).not.toContain('去AI味')
    expect(session.skillCatalogDigest).toBeUndefined()
    // 要素目录等其余注入不受影响
    expect(allText).toContain('<available_elements>')
    expect(fetchCalls[0]!.toolNames).toContain('LoadSkill')
  })

  it('要素管理员：不注入技能目录、工具面无 LoadSkill（误调收到失败回灌）', async () => {
    fetchHandler = (call, index) => {
      if (index === 0) {
        return toolCallSse('call-1', 'LoadSkill', { name: '去AI味' })
      }
      return textSse('已尝试加载')
    }

    const session = createElementManagerSession()
    await runChatDriver({ session, input: buildTurnInput(true) })

    // 工具面：LoadSkill 不在要素管理员的白名单工具面里
    expect(fetchCalls[0]!.toolNames).not.toContain('LoadSkill')
    expect(fetchCalls[0]!.toolNames).toContain('ReadFile')

    // 模型误调：收到失败回灌（未注册工具），会话不写技能 digest
    const loadSkillResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'LoadSkill',
    )
    expect(loadSkillResult?.ok).toBe(false)
    expect(session.skillCatalogDigest).toBeUndefined()
  })
})

describe('技能增删改查闭环（阶段 3，3.6：管理走通用文件工具）', () => {
  const SKILL_MD = '---\ndescription: 用天气推进情节\n---\n\n# 暴风雨写作法\n用风暴映射情绪。'

  /** 脚本化 LLM 桩：按调用序号回放预排好的响应（跨多个 runChatDriver 轮次连续消费）。 */
  let script: Response[]

  beforeEach(() => {
    script = []
    fetchHandler = () => script.shift() ?? textSse('（脚本耗尽）')
  })

  function turnInput(snapshot: ProjectSnapshot) {
    return {
      instruction: '',
      project: snapshot,
      config: stubConfig,
      systemPrompt: '',
      activeFilePath: null,
      confirm: async () => ({ accepted: true }),
    }
  }

  function enqueue(session: ChatSessionState, text: string) {
    session.inbox = enqueueToInbox(session.inbox, 'next-turn', { text }).state
  }

  function lastFetchText(): string {
    return fetchCalls[fetchCalls.length - 1]!.messages.map((message) => message.content ?? '').join('\n')
  }

  it('新建 → 同轮可加载 → 下一轮入目录 → 改描述原位替换 → 删除后目录移除且加载未找到', async () => {
    // 初始项目无技能（只有要素）；同一份快照贯穿全部轮次（文件落内存 FS 持续生效）
    const snapshot = project(false)
    const session = createChatSession('proj-skill-wiring')
    enqueue(session, '帮我新建一个暴风雨写作法技能')

    // 轮 1：CreateFile 新建技能 → 同一轮 LoadSkill 立即可加载（实时重扫）
    script.push(toolCallSse('t1-c1', 'CreateFile', { path: 'skills/暴风雨/SKILL.md', content: SKILL_MD }))
    script.push(toolCallSse('t1-c2', 'LoadSkill', { name: '暴风雨' }))
    script.push(textSse('技能已建好并验证可加载'))
    await runChatDriver({ session, input: turnInput(snapshot) })

    const loadResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'LoadSkill',
    )
    expect(loadResult?.ok).toBe(true)
    expect(loadResult?.resultSummary).toContain('暴风雨')

    // 轮 2：下一轮目录 reminder 出现该技能（首注文案）
    enqueue(session, '开始写正文')
    script.push(textSse('好的'))
    await runChatDriver({ session, input: turnInput(snapshot) })
    expect(lastFetchText()).toContain('<available_skills>')
    expect(lastFetchText()).toContain('- 暴风雨：用天气推进情节')
    expect(lastFetchText()).toContain('以下是本项目已安装的写作技能')

    // 轮 3：ReadFile（读技能文件走素材提示行）→ EditFile 改 description（走确认卡）
    enqueue(session, '把描述改得更清楚')
    script.push(toolCallSse('t3-c1', 'ReadFile', { path: 'skills/暴风雨/SKILL.md' }))
    script.push(toolCallSse('t3-c2', 'EditFile', {
      path: 'skills/暴风雨/SKILL.md',
      oldText: 'description: 用天气推进情节',
      newText: 'description: 用风暴强度映射人物情绪起伏',
    }))
    script.push(textSse('描述已更新'))
    await runChatDriver({ session, input: turnInput(snapshot) })

    const editResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'EditFile',
    )
    expect(editResult?.ok).toBe(true)

    // 轮 4：目录原地替换（更新文案 + 新描述，仍是唯一一条技能目录）
    enqueue(session, '继续')
    script.push(textSse('好的'))
    await runChatDriver({ session, input: turnInput(snapshot) })
    const turn4Text = lastFetchText()
    expect(turn4Text).toContain('- 暴风雨：用风暴强度映射人物情绪起伏')
    expect(turn4Text).toContain('取代此前任何版本')
    expect(turn4Text.match(/<available_skills>/g)).toHaveLength(1)

    // 轮 5：删除技能（进回收站）
    enqueue(session, '删掉这个技能')
    script.push(toolCallSse('t5-c1', 'DeleteFile', { path: 'skills/暴风雨/SKILL.md' }))
    script.push(textSse('已删除'))
    await runChatDriver({ session, input: turnInput(snapshot) })
    const deleteResult = session.messages.find(
      (message) => message.kind === 'tool-result' && message.toolName === 'DeleteFile',
    )
    expect(deleteResult?.ok).toBe(true)

    // 轮 6：目录已移除；LoadSkill 返回未找到（教学式，列空可用清单）
    enqueue(session, '再用一次')
    script.push(toolCallSse('t6-c1', 'LoadSkill', { name: '暴风雨' }))
    script.push(textSse('技能没了'))
    await runChatDriver({ session, input: turnInput(snapshot) })

    expect(lastFetchText()).not.toContain('<available_skills>')
    expect(session.skillCatalogDigest).toBeUndefined()
    const finalLoad = [...session.messages]
      .reverse()
      .find((message) => message.kind === 'tool-result' && message.toolName === 'LoadSkill')
    expect(finalLoad?.resultSummary).toContain('未找到技能「暴风雨」')
  })
})
