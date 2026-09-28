import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildGardenerSystemPrompt,
  createDelegateToGardenerTool,
  createGardenerTools,
  GARDENER_PERSONA,
} from './gardener'
import { isAgentToolName } from './tools'
import { executeAgentTool } from './tool-execution'
import type { TaggedToolExecutionEvent, WriteConfirmationRequest } from './tool-execution'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 园丁子代理（委派式，一次性上下文）测试：
 * - 提示词两层组装（persona + ELEMENT.md，无其他提示词家族文件）
 * - 工具白名单 + elements/ 写路径闸（运行层强制）
 * - 委派端到端（fetch stub）：主 Agent 调 DelegateToGardener → 园丁独立请求 → 汇报回灌
 * 全链只 stub fetch（SSE 编排），query / 工具执行 / 确认链全真实（照 session-driver.test.ts 模式）。
 */

/** 假项目句柄：只支持 readElementSchema 的读取路径（prompts/ELEMENT.md）。 */
function fakeProject(elementSchema: string | null): ProjectSnapshot {
  return {
    id: 'proj-gardener',
    name: '园丁测试项目',
    config: stubConfig,
    handle: {
      async getDirectoryHandle(name: string) {
        if (name !== 'prompts') {
          throw new DOMException(`Not found: ${name}`, 'NotFoundError')
        }
        return {
          async getFileHandle(fileName: string) {
            if (elementSchema === null || fileName !== 'ELEMENT.md') {
              throw new DOMException(`Not found: ${fileName}`, 'NotFoundError')
            }
            return {
              kind: 'file',
              name: fileName,
              async getFile() {
                return new File([elementSchema], fileName, { type: 'text/markdown' })
              },
            }
          },
        }
      },
    },
  } as unknown as ProjectSnapshot
}

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

describe('buildGardenerSystemPrompt', () => {
  it('persona + ELEMENT.md 全文两层组装；规范在 persona 之后', () => {
    const prompt = buildGardenerSystemPrompt('# 我的规范\n\n一人一文件。')
    expect(prompt.startsWith(GARDENER_PERSONA)).toBe(true)
    expect(prompt).toContain('【本书要素规范（prompts/ELEMENT.md）】')
    expect(prompt).toContain('# 我的规范\n\n一人一文件。')
    expect(prompt.indexOf(GARDENER_PERSONA)).toBeLessThan(prompt.indexOf('# 我的规范'))
  })

  it('规范缺失（空串）时附缺失提示，不阻塞', () => {
    const prompt = buildGardenerSystemPrompt('')
    expect(prompt).toContain(GARDENER_PERSONA)
    expect(prompt).toContain('规范文件 prompts/ELEMENT.md 缺失')
  })
})

describe('createGardenerTools', () => {
  it('工具白名单精确：六工具，无 DeleteFile/RenameFile/GetFileChangeHistory/Web/委派工具', () => {
    const tools = createGardenerTools()
    expect(Object.keys(tools).sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile'],
    )
  })

  it('写路径闸：EditFile 拒绝 chapters/，CreateFile 拒绝 prompts/ELEMENT.md', () => {
    const tools = createGardenerTools()
    expect(() => tools.EditFile!.core.validateInput({
      path: 'chapters/第001章-夜探剑冢.txt',
      oldText: 'a',
      newText: 'b',
    })).toThrowError(/园丁只能写入 elements\//)
    expect(() => tools.CreateFile!.core.validateInput({
      path: 'prompts/ELEMENT.md',
      content: 'x',
    })).toThrowError(/园丁只能写入 elements\//)
  })

  it('写路径闸：elements/ 下的写入放行（基础校验照常通过）', () => {
    const tools = createGardenerTools()
    expect(tools.CreateFile!.core.validateInput({
      path: 'elements/characters/云溪.md',
      content: '---\nname: 云溪\n---\n',
    })).toMatchObject({ path: 'elements/characters/云溪.md' })
    expect(tools.EditFile!.core.validateInput({
      path: 'elements/locations/剑冢.md',
      oldText: 'a',
      newText: 'b',
    })).toMatchObject({ path: 'elements/locations/剑冢.md' })
  })

  it('写路径闸大小写不敏感：Elements/ 前缀不因大小写被误拒', () => {
    const tools = createGardenerTools()
    expect(() => tools.CreateFile!.core.validateInput({
      path: 'Elements/characters/云溪.md',
      content: 'x',
    })).not.toThrow()
  })
})

describe('isAgentToolName', () => {
  it('DelegateToGardener 已入联合类型', () => {
    expect(isAgentToolName('DelegateToGardener')).toBe(true)
  })
})

// ---------- 委派端到端（fetch stub） ----------

type FetchCall = {
  messages: Array<{ role: string; content?: string | null }>
  toolNames: string[]
}

let fetchCalls: FetchCall[] = []
let fetchHandler: (call: FetchCall, index: number) => Response

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

beforeEach(() => {
  fetchCalls = []
  fetchHandler = () => textSse('默认回答')
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const call: FetchCall = {
      messages: body.messages ?? [],
      toolNames: (body.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name),
    }
    fetchCalls.push(call)
    return fetchHandler(call, fetchCalls.length - 1)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DelegateToGardener 委派端到端', () => {
  it('主 Agent 调委派 → 园丁独立请求（persona+规范、白名单工具面）→ 汇报回灌主 Agent', async () => {
    const schema = '# 我的要素规范\n\n一人一文件。'
    fetchHandler = (_call, index) => {
      if (index === 0) {
        // 园丁第一轮：调一个只读工具（在假句柄上会失败回灌，循环照常继续）
        return toolCallSse('t-gardener-1', 'ListDirectory', {})
      }
      return textSse('## 改动文件清单\n\n- 无改动样例汇报正文')
    }

    const subagentEvents: TaggedToolExecutionEvent[] = []
    const outerEvents: TaggedToolExecutionEvent[] = []
    const delegate = createDelegateToGardenerTool({
      onSubagentEvent: (event) => subagentEvents.push(event),
    })

    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-1',
        name: 'DelegateToGardener',
        input: { task: '整理第 12 章涉及的要素' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject(schema),
      tools: { DelegateToGardener: delegate },
      onEvent: (event) => outerEvents.push(event),
    })

    // 委派结果回灌主 Agent：汇报全文可见
    expect(result.content).toContain('园丁整理完成')
    expect(result.content).toContain('无改动样例汇报正文')

    // 园丁的两次模型请求
    expect(fetchCalls.length).toBe(2)

    // 园丁请求的 system = persona + ELEMENT.md 全文（且只有这两层）
    const systemMessage = fetchCalls[0]!.messages.find((message) => message.role === 'system')
    expect(systemMessage?.content).toContain(GARDENER_PERSONA)
    expect(systemMessage?.content).toContain('# 我的要素规范')
    expect(systemMessage?.content).toContain('【本书要素规范（prompts/ELEMENT.md）】')

    // 园丁请求的 user 消息含任务与范围
    const userMessage = [...fetchCalls[0]!.messages].reverse().find((message) => message.role === 'user')
    expect(userMessage?.content).toContain('整理第 12 章涉及的要素')
    expect(userMessage?.content).toContain('整个 elements/ 要素库')

    // 园丁工具面：白名单六工具，无委派工具（不嵌套）、无删除/改名/历史/Web
    expect(fetchCalls[0]!.toolNames.sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile'],
    )

    // 园丁内层工具事件带 gardener 归属标记（session 层据此折叠嵌套任务组）
    expect(subagentEvents.length).toBeGreaterThanOrEqual(2)
    expect(subagentEvents.every((event) => event.agent === 'gardener')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-call')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-result')).toBe(true)

    // 外层（主 Agent 执行面）只看到委派工具自身的事件，无 agent 标记
    expect(outerEvents.length).toBeGreaterThanOrEqual(2)
    expect(outerEvents.every((event) => event.agent === undefined)).toBe(true)
  })

  it('园丁写确认带「园丁」标签（与主 Agent 共用确认链，归属可辨）', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        // CreateFile 是结构操作：档位判定 ask → 走确认（写入在假句柄上会失败，确认链已验证）
        return toolCallSse('t-gardener-2', 'CreateFile', {
          path: 'elements/characters/云溪.md',
          content: '---\nname: 云溪\n---\n',
        })
      }
      return textSse('## 改动文件清单\n\n- elements/characters/云溪.md（新建）')
    }

    const delegate = createDelegateToGardenerTool({
      confirm: async (request) => {
        confirmRequests.push(request)
        return { accepted: true }
      },
    })

    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-2',
        name: 'DelegateToGardener',
        input: { task: '补建云溪人物卡', scope: 'elements/characters/' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject('# 规范'),
      tools: { DelegateToGardener: delegate },
    })

    expect(confirmRequests.length).toBe(1)
    expect(confirmRequests[0]!.agentLabel).toBe('园丁')
    expect(confirmRequests[0]!.confirmation.kind).toBe('create')
    // 确认被接受后工具照常执行（假句柄上写入失败回灌，循环继续），最终拿到完整汇报
    expect(result.content).toContain('云溪.md（新建）')
  })

  it('task 为空字符串被参数校验拒绝', async () => {
    const delegate = createDelegateToGardenerTool({})
    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-3',
        name: 'DelegateToGardener',
        input: { task: '   ' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject('# 规范'),
      tools: { DelegateToGardener: delegate },
    })
    expect(result.content).toContain('task 不能为空')
    // 校验失败不发起任何模型请求
    expect(fetchCalls.length).toBe(0)
  })
})
