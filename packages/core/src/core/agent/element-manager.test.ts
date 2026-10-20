import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildElementManagerSystemPrompt,
  buildElementSchemaReminder,
  createDelegateToElementManagerTool,
  createElementManagerTools,
  mergeElementManagerOverrides,
} from './element-manager'
import { PROJECT_STRUCTURE_SECTION } from './prompt'
import { isAgentToolName } from './tools'
import { executeAgentTool } from './tool-execution'
import type { TaggedToolExecutionEvent, WriteConfirmationRequest } from './tool-execution'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 要素管理员子代理（委派式，一次性上下文）测试：
 * - system 五段分层（身份含模型名 + 项目结构共用段 + 工具规则 + Notes + 汇报格式，升级 W2）
 * - ELEMENT.md 以 user-role `<system-reminder>` 恒注入（D2/D3），不再拼进 system
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
  it('五段分层：身份（含模型名）+ 项目结构 + 工具规则 + Notes + 汇报格式，依序排列', () => {
    const prompt = buildElementManagerSystemPrompt({ model: 'deepseek-chat' })
    expect(prompt).toContain('你是 NovAI 要素管理员，一个使用 deepseek-chat 模型驱动的子智能体')
    // 项目结构段与主 Agent 共用同一份常量（单一来源，防两份漂移）
    expect(prompt).toContain(PROJECT_STRUCTURE_SECTION)
    expect(prompt).toContain('工具使用规则：')
    expect(prompt).toContain('Notes:')
    expect(prompt).toContain('## 改动文件清单')

    const sectionOrder = [
      prompt.indexOf('你是 NovAI 要素管理员'),
      prompt.indexOf('本项目是一个小说工程'),
      prompt.indexOf('工具使用规则：'),
      prompt.indexOf('Notes:'),
      prompt.indexOf('任务结束时输出固定结构汇报'),
    ]
    expect(sectionOrder.every((index) => index >= 0)).toBe(true)
    expect([...sectionOrder].sort((a, b) => a - b)).toEqual(sectionOrder)
  })

  it('工具规则段只写白名单内工具：无 Web/删除/章节编号口径，保留 spill 与要素口径', () => {
    const prompt = buildElementManagerSystemPrompt({ model: 'm' })
    expect(prompt).toContain('spill')
    expect(prompt).toContain('文件名即要素名')
    expect(prompt).not.toContain('WebSearch')
    expect(prompt).not.toContain('WebFetch')
    expect(prompt).not.toContain('KnowledgeLookup')
    expect(prompt).not.toContain('DeleteFile')
    expect(prompt).not.toContain('chapters/*.txt 盘点')
  })

  it('Notes 铁律与汇报格式：elements/ 写边界、重命名说明理由、四段汇报', () => {
    const prompt = buildElementManagerSystemPrompt({ model: 'm' })
    expect(prompt).toContain('你只能写入 elements/ 下的文件')
    expect(prompt).toContain('你可以重命名 elements/ 下的要素文件')
    expect(prompt).toContain('不删除任何文件')
    expect(prompt).toContain('## 合并与迁移说明')
    expect(prompt).toContain('## 存疑事项')
    expect(prompt).toContain('## 建议删除')
  })

  it('模型缺省或空白时退化为无模型名身份段', () => {
    expect(buildElementManagerSystemPrompt({})).toContain('你是 NovAI 要素管理员，一个子智能体')
    expect(buildElementManagerSystemPrompt({ model: '   ' })).not.toContain('模型驱动')
  })
})

describe('buildElementSchemaReminder', () => {
  it('ELEMENT.md 全文包裹为 user-role system-reminder', () => {
    const reminder = buildElementSchemaReminder('# 我的规范\n\n一人一文件。')
    expect(reminder.startsWith('<system-reminder>')).toBe(true)
    expect(reminder.endsWith('</system-reminder>')).toBe(true)
    expect(reminder).toContain('以下是本书要素规范（prompts/ELEMENT.md）')
    expect(reminder).toContain('# 我的规范\n\n一人一文件。')
  })
})

describe('createElementManagerTools', () => {
  it('工具白名单精确：七工具（W3 起 RenameFile 已放开），无 DeleteFile/GetFileChangeHistory/Web/委派工具', () => {
    const tools = createElementManagerTools()
    expect(Object.keys(tools).sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile', 'RenameFile'],
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

  it('RenameFile 路径闸：fromPath/toPath 双向都在 elements/ 内放行（基础校验照常通过）', () => {
    const tools = createElementManagerTools()
    expect(tools.RenameFile!.core.validateInput({
      fromPath: 'elements/characters/角色甲.md',
      toPath: 'elements/characters/甲.md',
    })).toMatchObject({ fromPath: 'elements/characters/角色甲.md', toPath: 'elements/characters/甲.md' })
  })

  it('RenameFile 路径闸：fromPath 越界（chapters/）被拒', () => {
    const tools = createElementManagerTools()
    expect(() => tools.RenameFile!.core.validateInput({
      fromPath: 'chapters/第001章-夜探剑冢.txt',
      toPath: 'elements/characters/剑冢.md',
    })).toThrowError(/要素管理员只能重命名 elements\//)
  })

  it('RenameFile 路径闸：toPath 越界（prompts/）被拒', () => {
    const tools = createElementManagerTools()
    expect(() => tools.RenameFile!.core.validateInput({
      fromPath: 'elements/characters/角色甲.md',
      toPath: 'prompts/角色甲.md',
    })).toThrowError(/源文件与目标文件都必须在 elements\//)
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
  it('主 Agent 调委派 → 要素管理员独立请求（分层 system + ELEMENT.md reminder、白名单工具面）→ 汇报回灌主 Agent', async () => {
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
        input: { task: '管理第 12 章涉及的要素' },
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

    // system = 五段分层（身份含模型名 + 项目结构 + 工具规则 + Notes + 汇报格式），
    // 且不再含 ELEMENT.md 内容（W2 D2：规范改走 user-role reminder）
    const systemMessage = fetchCalls[0]!.messages.find((message) => message.role === 'system')
    expect(systemMessage?.content).toContain('你是 NovAI 要素管理员，一个使用 model 模型驱动的子智能体')
    expect(systemMessage?.content).toContain(PROJECT_STRUCTURE_SECTION)
    expect(systemMessage?.content).toContain('Notes:')
    expect(systemMessage?.content).toContain('## 改动文件清单')
    expect(systemMessage?.content).not.toContain('# 我的要素规范')
    expect(systemMessage?.content).not.toContain('【本书要素规范')

    // user 第一条是 ELEMENT.md reminder（恒注入，含全文）；最后一条是任务与范围
    const userMessages = fetchCalls[0]!.messages.filter((message) => message.role === 'user')
    expect(userMessages[0]?.content).toContain('<system-reminder>')
    expect(userMessages[0]?.content).toContain('以下是本书要素规范（prompts/ELEMENT.md）')
    expect(userMessages[0]?.content).toContain('# 我的要素规范')
    expect(userMessages[userMessages.length - 1]?.content).toContain('管理第 12 章涉及的要素')
    expect(userMessages[userMessages.length - 1]?.content).toContain('整个 elements/ 要素库')

    // 要素管理员工具面：白名单七工具（W3 起 RenameFile 已放开），无委派工具（不嵌套）、无删除/历史/Web
    expect(fetchCalls[0]!.toolNames.sort()).toEqual(
      ['CreateFile', 'EditFile', 'FindFiles', 'ListDirectory', 'RagSearch', 'ReadFile', 'RenameFile'],
    )

    // 要素管理员内层工具事件带 element-manager 归属标记（session 层据此折叠嵌套任务组）
    expect(subagentEvents.length).toBeGreaterThanOrEqual(2)
    expect(subagentEvents.every((event) => event.agent === 'element-manager')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-call')).toBe(true)
    expect(subagentEvents.some((event) => event.type === 'tool-result')).toBe(true)

    // 外层（主 Agent 执行面）只看到委派工具自身的事件，无 agent 标记
    expect(outerEvents.length).toBeGreaterThanOrEqual(2)
    expect(outerEvents.every((event) => event.agent === undefined)).toBe(true)
  })

  it('ELEMENT.md 缺失：reminder 附缺失提示，不阻塞运行', async () => {
    fetchHandler = () => textSse('## 改动文件清单\n\n- 无')

    const delegate = createDelegateToElementManagerTool({})
    await executeAgentTool({
      call: {
        id: 'c-delegate-missing', name: 'DelegateToElementManager',
        input: { task: '管理全库' }, createdAt: new Date().toISOString(),
      },
      project: fakeProject(null),
      tools: { DelegateToElementManager: delegate },
    })

    expect(fetchCalls.length).toBe(1)
    const userMessages = fetchCalls[0]!.messages.filter((message) => message.role === 'user')
    expect(userMessages[0]?.content).toContain('<system-reminder>')
    expect(userMessages[0]?.content).toContain('ELEMENT.md 缺失')
  })

  it('要素管理员写确认带「要素管理」标签（与主 Agent 共用确认链，归属可辨）', async () => {
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
  it('要素管理员覆盖模型：请求打到覆盖 baseUrl/model，身份段模型名随覆盖值', async () => {
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
        input: { task: '管理全库' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toBe('https://elementManager.example.com/v1/chat/completions')
    expect(fetchCalls[0]!.model).toBe('elementManager-model')
    // 身份段模型名跟随合成后的覆盖模型（W2：与主 Agent 同款句式）
    const systemMessage = fetchCalls[0]!.messages.find((message) => message.role === 'system')
    expect(systemMessage?.content).toContain('使用 elementManager-model 模型驱动的子智能体')
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
        input: { task: '管理' }, createdAt: new Date().toISOString(),
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
        input: { task: '管理' }, createdAt: new Date().toISOString(),
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
        input: { task: '管理' }, createdAt: new Date().toISOString(),
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
        input: { task: '管理' }, createdAt: new Date().toISOString(),
      },
      project: { ...fakeProject('# 规范'), config },
      tools: { DelegateToElementManager: delegate },
    })

    expect(confirmRequests.length).toBe(1)
  })
})
