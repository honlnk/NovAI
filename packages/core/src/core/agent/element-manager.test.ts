import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildElementManagerSystemPrompt,
  createDelegateToElementManagerTool,
  createElementManagerTools,
  ELEMENT_MANAGER_PERSONA,
  mergeElementManagerOverrides,
} from './element-manager'
import { isAgentToolName } from './tools'
import { executeAgentTool } from './tool-execution'
import type { TaggedToolExecutionEvent, WriteConfirmationRequest } from './tool-execution'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 要素管理员子代理（委派式，一次性上下文）测试：
 * - 提示词两层组装（persona + ELEMENT.md，无其他提示词家族文件）
 * - 工具白名单 + elements/ 写路径闸（运行层强制）
 * - 委派端到端（fetch stub）：主 Agent 调 DelegateToElementManager → 要素管理员独立请求 → 汇报回灌
 * 全链只 stub fetch（SSE 编排），query / 工具执行 / 确认链全真实（照 session-driver.test.ts 模式）。
 */

/** 假项目句柄：只支持 readElementSchema 的读取路径（prompts/ELEMENT.md）。 */
function fakeProject(elementSchema: string | null): ProjectSnapshot {
  return {
    id: 'proj-elementManager',
    name: '要素管理员测试项目',
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

describe('buildElementManagerSystemPrompt', () => {
  it('persona + ELEMENT.md 全文两层组装；规范在 persona 之后', () => {
    const prompt = buildElementManagerSystemPrompt('# 我的规范\n\n一人一文件。')
    expect(prompt.startsWith(ELEMENT_MANAGER_PERSONA)).toBe(true)
    expect(prompt).toContain('【本书要素规范（prompts/ELEMENT.md）】')
    expect(prompt).toContain('# 我的规范\n\n一人一文件。')
    expect(prompt.indexOf(ELEMENT_MANAGER_PERSONA)).toBeLessThan(prompt.indexOf('# 我的规范'))
  })

  it('规范缺失（空串）时附缺失提示，不阻塞', () => {
    const prompt = buildElementManagerSystemPrompt('')
    expect(prompt).toContain(ELEMENT_MANAGER_PERSONA)
    expect(prompt).toContain('规范文件 prompts/ELEMENT.md 缺失')
  })
})

describe('createElementManagerTools', () => {
  it('工具白名单精确：六工具，无 DeleteFile/RenameFile/GetFileChangeHistory/Web/委派工具', () => {
    const tools = createElementManagerTools()
    expect(Object.keys(tools).sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile'],
    )
  })

  it('写路径闸：EditFile 拒绝 chapters/，CreateFile 拒绝 prompts/ELEMENT.md', () => {
    const tools = createElementManagerTools()
    expect(() => tools.EditFile!.core.validateInput({
      path: 'chapters/第001章-夜探剑冢.txt',
      oldText: 'a',
      newText: 'b',
    })).toThrowError(/要素管理员只能写入 elements\//)
    expect(() => tools.CreateFile!.core.validateInput({
      path: 'prompts/ELEMENT.md',
      content: 'x',
    })).toThrowError(/要素管理员只能写入 elements\//)
  })

  it('写路径闸：elements/ 下的写入放行（基础校验照常通过）', () => {
    const tools = createElementManagerTools()
    expect(tools.CreateFile!.core.validateInput({
      path: 'elements/characters/角色甲.md',
      content: '---\nname: 角色甲\n---\n',
    })).toMatchObject({ path: 'elements/characters/角色甲.md' })
    expect(tools.EditFile!.core.validateInput({
      path: 'elements/locations/剑冢.md',
      oldText: 'a',
      newText: 'b',
    })).toMatchObject({ path: 'elements/locations/剑冢.md' })
  })

  it('写路径闸大小写不敏感：Elements/ 前缀不因大小写被误拒', () => {
    const tools = createElementManagerTools()
    expect(() => tools.CreateFile!.core.validateInput({
      path: 'Elements/characters/角色甲.md',
      content: 'x',
    })).not.toThrow()
  })
})

describe('isAgentToolName', () => {
  it('DelegateToElementManager 已入联合类型', () => {
    expect(isAgentToolName('DelegateToElementManager')).toBe(true)
  })
})

// ---------- 委派端到端（fetch stub） ----------

type FetchCall = {
  url: string
  model: string
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
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}')
    const call: FetchCall = {
      url: String(url),
      model: body.model ?? '',
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

describe('DelegateToElementManager 委派端到端', () => {
  it('主 Agent 调委派 → 要素管理员独立请求（persona+规范、白名单工具面）→ 汇报回灌主 Agent', async () => {
    const schema = '# 我的要素规范\n\n一人一文件。'
    fetchHandler = (_call, index) => {
      if (index === 0) {
        // 要素管理员第一轮：调一个只读工具（在假句柄上会失败回灌，循环照常继续）
        return toolCallSse('t-elementManager-1', 'ListDirectory', {})
      }
      return textSse('## 改动文件清单\n\n- 无改动样例汇报正文')
    }

    const subagentEvents: TaggedToolExecutionEvent[] = []
    const outerEvents: TaggedToolExecutionEvent[] = []
    const delegate = createDelegateToElementManagerTool({
      onSubagentEvent: (event) => subagentEvents.push(event),
    })

    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-1',
        name: 'DelegateToElementManager',
        input: { task: '整理第 12 章涉及的要素' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject(schema),
      tools: { DelegateToElementManager: delegate },
      onEvent: (event) => outerEvents.push(event),
    })

    // 委派结果回灌主 Agent：汇报全文可见
    expect(result.content).toContain('要素管理完成')
    expect(result.content).toContain('无改动样例汇报正文')

    // 要素管理员的两次模型请求
    expect(fetchCalls.length).toBe(2)

    // 要素管理员请求的 system = persona + ELEMENT.md 全文（且只有这两层）
    const systemMessage = fetchCalls[0]!.messages.find((message) => message.role === 'system')
    expect(systemMessage?.content).toContain(ELEMENT_MANAGER_PERSONA)
    expect(systemMessage?.content).toContain('# 我的要素规范')
    expect(systemMessage?.content).toContain('【本书要素规范（prompts/ELEMENT.md）】')

    // 要素管理员请求的 user 消息含任务与范围
    const userMessage = [...fetchCalls[0]!.messages].reverse().find((message) => message.role === 'user')
    expect(userMessage?.content).toContain('整理第 12 章涉及的要素')
    expect(userMessage?.content).toContain('整个 elements/ 要素库')

    // 要素管理员工具面：白名单六工具，无委派工具（不嵌套）、无删除/改名/历史/Web
    expect(fetchCalls[0]!.toolNames.sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile'],
    )

    // 要素管理员内层工具事件带 elementManager 归属标记（session 层据此折叠嵌套任务组）
    expect(subagentEvents.length).toBeGreaterThanOrEqual(2)
    expect(subagentEvents.every((event) => event.agent === 'element-manager')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-call')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-result')).toBe(true)

    // 外层（主 Agent 执行面）只看到委派工具自身的事件，无 agent 标记
    expect(outerEvents.length).toBeGreaterThanOrEqual(2)
    expect(outerEvents.every((event) => event.agent === undefined)).toBe(true)
  })

  it('要素管理员写确认带「要素管理员」标签（与主 Agent 共用确认链，归属可辨）', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        // CreateFile 是结构操作：档位判定 ask → 走确认（写入在假句柄上会失败，确认链已验证）
        return toolCallSse('t-elementManager-2', 'CreateFile', {
          path: 'elements/characters/角色甲.md',
          content: '---\nname: 角色甲\n---\n',
        })
      }
      return textSse('## 改动文件清单\n\n- elements/characters/角色甲.md（新建）')
    }

    const delegate = createDelegateToElementManagerTool({
      confirm: async (request) => {
        confirmRequests.push(request)
        return { accepted: true }
      },
    })

    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-2',
        name: 'DelegateToElementManager',
        input: { task: '补建角色甲人物卡', scope: 'elements/characters/' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject('# 规范'),
      tools: { DelegateToElementManager: delegate },
    })

    expect(confirmRequests.length).toBe(1)
    expect(confirmRequests[0]!.agentLabel).toBe('要素管理')
    expect(confirmRequests[0]!.confirmation.kind).toBe('create')
    // 确认被接受后工具照常执行（假句柄上写入失败回灌，循环继续），最终拿到完整汇报
    expect(result.content).toContain('角色甲.md（新建）')
  })

  it('task 为空字符串被参数校验拒绝', async () => {
    const delegate = createDelegateToElementManagerTool({})
    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-3',
        name: 'DelegateToElementManager',
        input: { task: '   ' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject('# 规范'),
      tools: { DelegateToElementManager: delegate },
    })
    expect(result.content).toContain('task 不能为空')
    // 校验失败不发起任何模型请求
    expect(fetchCalls.length).toBe(0)
  })
})

// ---------- 要素管理员独立配置（Phase 2 计划 W1：mergeElementManagerOverrides 合成快照） ----------

describe('mergeElementManagerOverrides', () => {
  const baseConfig = {
    llm: {
      baseUrl: 'https://main.example.com',
      apiKey: 'main-key',
      model: 'main-model',
      protocol: 'openai',
      reasoningEffort: 'low',
    },
    settings: {
      permissionPreset: 'review',
    },
  } as unknown as ProjectConfig

  it('无覆盖块返回原引用（全继承，零合成开销）', () => {
    expect(mergeElementManagerOverrides(baseConfig)).toBe(baseConfig)
  })

  it('llm 覆盖整组生效；reasoningEffort 不带键时继承主值（不被 undefined 键遮蔽）', () => {
    const config = {
      ...baseConfig,
      elementManager: {
        llm: { baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'claude-x', protocol: 'anthropic' },
      },
    } as ProjectConfig
    const merged = mergeElementManagerOverrides(config)
    expect(merged.llm.baseUrl).toBe('https://strong.example.com')
    expect(merged.llm.model).toBe('claude-x')
    expect(merged.llm.protocol).toBe('anthropic')
    // 覆盖块未带思考档 → 继承主 Agent 当前档（D4：动态继承，非关闭）
    expect(merged.llm.reasoningEffort).toBe('low')
    // 原配置对象不被就地修改
    expect(baseConfig.llm.model).toBe('main-model')
  })

  it('llm 覆盖带思考档时覆盖生效', () => {
    const config = {
      ...baseConfig,
      elementManager: {
        llm: {
          baseUrl: 'https://strong.example.com', apiKey: 'k', model: 'm', protocol: 'openai',
          reasoningEffort: 'max',
        },
      },
    } as ProjectConfig
    expect(mergeElementManagerOverrides(config).llm.reasoningEffort).toBe('max')
  })

  it('permissionPreset 覆盖写进 settings（判定链无感知）；未覆盖时取主档当前值', () => {
    const overridden = mergeElementManagerOverrides({
      ...baseConfig,
      elementManager: { permissionPreset: 'full' },
    } as ProjectConfig)
    expect(overridden.settings.permissionPreset).toBe('full')

    const inherited = mergeElementManagerOverrides({
      ...baseConfig,
      elementManager: { llm: { baseUrl: 'https://x.com', apiKey: 'k', model: 'm', protocol: 'openai' } },
    } as ProjectConfig)
    // 只覆盖模型不覆盖档位 → 档位动态继承主值（review）
    expect(inherited.settings.permissionPreset).toBe('review')
  })
})

describe('要素管理员独立配置端到端（覆盖生效）', () => {
  it('要素管理员覆盖模型：请求打到覆盖 baseUrl/model，而非主 Agent 配置', async () => {
    fetchHandler = () => textSse('## 改动文件清单\n\n- 无')

    const config = {
      ...stubConfig,
      elementManager: {
        llm: {
          baseUrl: 'https://elementManager.example.com/v1',
          apiKey: 'elementManager-key',
          model: 'elementManager-model',
          protocol: 'openai',
        },
      },
    } as ProjectConfig
    const delegate = createDelegateToElementManagerTool({})
    await executeAgentTool({
      call: {
        id: 'c-delegate-4', name: 'DelegateToElementManager',
        input: { task: '整理全库' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toBe('https://elementManager.example.com/v1/chat/completions')
    expect(fetchCalls[0]!.model).toBe('elementManager-model')
  })

  it('要素管理员档位 material：EditFile 改 elements 正文静默执行，不弹确认卡', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        return toolCallSse('t-w1a', 'EditFile', {
          path: 'elements/characters/角色甲.md', oldText: '旧', newText: '新',
        })
      }
      return textSse('## 改动文件清单\n\n- 无')
    }

    const config = {
      ...stubConfig,
      settings: { ...stubConfig.settings, permissionPreset: 'review' },
      elementManager: { permissionPreset: 'material' },
    } as unknown as ProjectConfig
    const delegate = createDelegateToElementManagerTool({
      confirm: (request) => {
        confirmRequests.push(request)
        return Promise.resolve({ accepted: true })
      },
    })
    await executeAgentTool({
      call: {
        id: 'c-delegate-5', name: 'DelegateToElementManager',
        input: { task: '整理' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    // 主档位 review 本会全弹卡；要素管理员覆盖 material 后，elements 内容修改静默放行（收紧→放宽方向）
    expect(confirmRequests.length).toBe(0)
  })

  it('要素管理员档位 review 收紧：主档位放行的修改也弹确认卡（双向生效）', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        return toolCallSse('t-w1b', 'EditFile', {
          path: 'elements/characters/角色甲.md', oldText: '旧', newText: '新',
        })
      }
      return textSse('## 改动文件清单\n\n- 无')
    }

    const config = {
      ...stubConfig,
      settings: { ...stubConfig.settings, permissionPreset: 'chapter-material' },
      elementManager: { permissionPreset: 'review' },
    } as unknown as ProjectConfig
    const delegate = createDelegateToElementManagerTool({
      confirm: (request) => {
        confirmRequests.push(request)
        return Promise.resolve({ accepted: true })
      },
    })
    await executeAgentTool({
      call: {
        id: 'c-delegate-6', name: 'DelegateToElementManager',
        input: { task: '整理' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    // 主档位 chapter-material 本会静默；要素管理员覆盖 review 后弹卡——confirm 闭包方案做不到的方向（D1）
    expect(confirmRequests.length).toBe(1)
    expect(confirmRequests[0]!.agentLabel).toBe('要素管理')
  })

  it('要素管理员档位 full：结构操作（CreateFile）也静默', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        return toolCallSse('t-w1c', 'CreateFile', {
          path: 'elements/entities/青霜剑.md', content: '# 青霜剑',
        })
      }
      return textSse('## 改动文件清单\n\n- 无')
    }

    const config = {
      ...stubConfig,
      settings: { ...stubConfig.settings, permissionPreset: 'review' },
      elementManager: { permissionPreset: 'full' },
    } as unknown as ProjectConfig
    const delegate = createDelegateToElementManagerTool({
      confirm: (request) => {
        confirmRequests.push(request)
        return Promise.resolve({ accepted: true })
      },
    })
    await executeAgentTool({
      call: {
        id: 'c-delegate-7', name: 'DelegateToElementManager',
        input: { task: '整理' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    expect(confirmRequests.length).toBe(0)
  })

  it('无覆盖块：要素管理员档位跟随主档位（继承基线，主 review → 全弹卡）', async () => {
    const confirmRequests: WriteConfirmationRequest[] = []
    fetchHandler = (_call, index) => {
      if (index === 0) {
        return toolCallSse('t-w1d', 'EditFile', {
          path: 'elements/characters/角色甲.md', oldText: '旧', newText: '新',
        })
      }
      return textSse('## 改动文件清单\n\n- 无')
    }

    const config = {
      ...stubConfig,
      settings: { ...stubConfig.settings, permissionPreset: 'review' },
    } as unknown as ProjectConfig
    const delegate = createDelegateToElementManagerTool({
      confirm: (request) => {
        confirmRequests.push(request)
        return Promise.resolve({ accepted: true })
      },
    })
    await executeAgentTool({
      call: {
        id: 'c-delegate-8', name: 'DelegateToElementManager',
        input: { task: '整理' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    expect(confirmRequests.length).toBe(1)
  })
})
