import { describe, expect, it } from 'vitest'

import {
  buildElementManagerSystemPrompt,
  buildElementSchemaReminder,
  buildElementManagerTaskText,
  createDelegateToElementManagerTool,
  createElementManagerTools,
  mergeElementManagerOverrides,
} from './element-manager'
import { PROJECT_STRUCTURE_SECTION } from './prompt'
import { isAgentToolName } from './tools'
import { executeAgentTool } from './tool-execution'
import type { DelegationSessionResult } from './element-manager'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 要素管理员（角色机制 W3 起委派会话化）测试：
 * - system 五段分层（身份含模型名 + 项目结构共用段 + 工具规则 + Notes + 汇报格式，升级 W2）
 * - ELEMENT.md 以 user-role `<system-reminder>` 恒注入（D2/D3，机制在 roles.ts 测）
 * - 工具白名单 + elements/ 写路径闸（运行层强制）
 * - 委派工具是薄壳：task/scope/project/signal 透传给注入的委派会话驱动器（service 层实现，
 *   端到端见 agent-service.delegation.test.ts）
 */

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
  },
} as unknown as ProjectConfig

/** 最小项目快照：委派工具只把 project 原样透传给 runner，不读文件。 */
function fakeProject(): ProjectSnapshot {
  return {
    id: 'proj-elementManager',
    name: '要素管理员测试项目',
    config: stubConfig,
    handle: {},
  } as unknown as ProjectSnapshot
}

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

// ---------- 委派工具（薄壳：透传给注入的委派会话驱动器） ----------

describe('createDelegateToElementManagerTool', () => {
  it('run 把 task/scope/project/signal 原样透传给 runner；结果经 formatResult 回灌主 Agent', async () => {
    const project = fakeProject()
    const signal = new AbortController().signal
    let received: Record<string, unknown> | undefined
    const tool = createDelegateToElementManagerTool({
      signal,
      runDelegationSession: async (input) => {
        received = { ...input }
        return {
          sessionId: 'session-em-1',
          report: '## 改动文件清单\n\n- elements/characters/角色甲.md（新建）',
          aborted: false,
          toolCallCount: 3,
        }
      },
    })

    // 委派是长任务，串行执行；工具本体不直接写文件
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(false)

    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-1',
        name: 'DelegateToElementManager',
        input: { task: '整理第 12 章新增人物', scope: 'elements/characters/' },
        createdAt: new Date().toISOString(),
      },
      project,
      tools: { DelegateToElementManager: tool },
    })

    expect(received).toMatchObject({
      task: '整理第 12 章新增人物',
      scope: 'elements/characters/',
    })
    expect((received as { project?: ProjectSnapshot } | undefined)?.project).toBe(project)
    expect((received as { signal?: AbortSignal } | undefined)?.signal).toBe(signal)

    // 汇报全文 + 会话句柄都回灌给主 Agent
    expect(result.content).toContain('要素管理完成')
    expect(result.content).toContain('角色甲.md（新建）')
    expect(result.content).toContain('session-em-1')
    expect(result.content).toContain('完整过程保存在要素管理员会话')
  })

  it('runner 未注入：run 报「委派运行时未注入」（会话层装配缺失的防御）', async () => {
    const tool = createDelegateToElementManagerTool({})
    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-missing-runner',
        name: 'DelegateToElementManager',
        input: { task: '管理全库' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject(),
      tools: { DelegateToElementManager: tool },
    })
    expect(result.content).toContain('委派运行时未注入')
  })

  it('aborted 结果：formatResult 带停止提示，summarize 同步降级', async () => {
    const abortedResult: DelegationSessionResult = {
      sessionId: 'session-em-2',
      report: '## 改动文件清单\n\n- 部分完成',
      aborted: true,
      toolCallCount: 2,
    }
    const tool = createDelegateToElementManagerTool({
      runDelegationSession: async () => abortedResult,
    })
    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-aborted',
        name: 'DelegateToElementManager',
        input: { task: '管理全库' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject(),
      tools: { DelegateToElementManager: tool },
    })
    expect(result.content).toContain('要素管理任务被用户停止')
    expect(result.content).toContain('部分完成')
    expect(tool.core.summarizeOutput(abortedResult)).toContain('被停止')
    expect(tool.core.summarizeInput({ task: '整理人物', scope: 'elements/characters/' }))
      .toContain('范围：elements/characters/')
  })

  it('task 为空字符串被参数校验拒绝（不触达 runner）', async () => {
    let runnerCalled = false
    const tool = createDelegateToElementManagerTool({
      runDelegationSession: async () => {
        runnerCalled = true
        return { sessionId: 's', report: '', aborted: false, toolCallCount: 0 }
      },
    })
    const result = await executeAgentTool({
      call: {
        id: 'c-delegate-empty-task',
        name: 'DelegateToElementManager',
        input: { task: '   ' },
        createdAt: new Date().toISOString(),
      },
      project: fakeProject(),
      tools: { DelegateToElementManager: tool },
    })
    expect(result.content).toContain('task 不能为空')
    expect(runnerCalled).toBe(false)
  })
})

describe('buildElementManagerTaskText', () => {
  it('任务 + 显式范围 + 固定收尾句', () => {
    const text = buildElementManagerTaskText('整理第 12 章新增人物', 'elements/characters/')
    expect(text).toContain('管理任务：整理第 12 章新增人物')
    expect(text).toContain('管理范围：elements/characters/')
    expect(text.endsWith('请按要素规范管理，结束时输出固定结构汇报。')).toBe(true)
  })

  it('范围缺省为整个 elements/ 要素库', () => {
    const text = buildElementManagerTaskText('管理全库', undefined)
    expect(text).toContain('管理范围：整个 elements/ 要素库')
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
