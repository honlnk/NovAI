import { describe, expect, it } from 'vitest'

import { AGENT_ROLES, getAgentRole, listAgentRoles } from './roles'
import { buildAgentSystemPrompt, buildAgentUserContext } from './prompt'
import { buildElementManagerSystemPrompt, mergeElementManagerOverrides } from './element-manager'
import { isAgentToolName } from './tools'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 角色注册表测试（《角色注册机制施工计划》W1 验收）：
 * - 注册表可列出两个角色，取声明缺省归主角色；
 * - 主角色声明与重构前的硬编码装配完全等价（system prompt / 用户上下文包装 / 工具面）；
 * - 要素管理员声明白名单无委派工具（防递归）、约束文档与配置覆盖声明就位。
 */

const stubProject = {
  id: 'proj-roles',
  name: '角色测试项目',
  handle: {},
} as unknown as ProjectSnapshot

function toolNames(tools: Record<string, unknown>): string[] {
  return Object.keys(tools)
}

describe('角色注册表', () => {
  it('列出两个注册角色，id 唯一', () => {
    const roles = listAgentRoles()
    expect(roles.map((role) => role.id)).toEqual(['main', 'element-manager'])
    expect(new Set(roles.map((role) => role.id)).size).toBe(roles.length)
  })

  it('未指定角色（缺省）取主角色；空串/null 同样归主角色', () => {
    expect(getAgentRole(undefined).id).toBe('main')
    expect(getAgentRole(null).id).toBe('main')
    expect(getAgentRole('').id).toBe('main')
  })

  it('按 id 取声明；未知角色抛错', () => {
    expect(getAgentRole('element-manager').id).toBe('element-manager')
    expect(() => getAgentRole('nobody' as never)).toThrow('未知角色')
  })

  it('注册表键与角色声明 id 一致', () => {
    for (const role of listAgentRoles()) {
      expect(AGENT_ROLES[role.id].id).toBe(role.id)
    }
  })
})

describe('主角色声明与重构前装配等价', () => {
  it('buildSystemPrompt 与 buildAgentSystemPrompt 同参输出一致', () => {
    const input = { model: 'deepseek-chat', systemPrompt: '自定义硬约束' }
    expect(AGENT_ROLES.main.buildSystemPrompt(input)).toBe(buildAgentSystemPrompt(input))
  })

  it('wrapUserContent 与 buildAgentUserContext 同参输出一致', () => {
    const input = {
      instruction: '写第一章',
      quote: '引用内容',
      project: stubProject,
      target: null,
    }
    expect(AGENT_ROLES.main.wrapUserContent(input)).toBe(buildAgentUserContext(input))
  })

  it('工具面 = 全量工具 + 委派工具（与重构前硬编码一致）', () => {
    const expectedFull = [
      'ReadFile', 'EditFile', 'CreateFile', 'RenameFile', 'DeleteFile',
      'ListDirectory', 'FindFiles', 'RagSearch', 'GetFileChangeHistory',
      'WebSearch', 'WebFetch', 'KnowledgeLookup',
    ]
    const tools = AGENT_ROLES.main.createTools()
    const names = toolNames(tools)
    expect(names).toEqual([...expectedFull, 'DelegateToElementManager'])
    for (const name of names) {
      expect(isAgentToolName(name)).toBe(true)
    }
    // context 是委派工具的运行态（confirm/signal/事件转发），不传也能装配（测试/纯装配场景）
    expect(AGENT_ROLES.main.createTools({})).toHaveProperty('DelegateToElementManager')
  })

  it('注入面声明：项目记忆与大纲都注入；不可被委派', () => {
    expect(AGENT_ROLES.main.injectNovaiOverview).toBe(true)
    expect(AGENT_ROLES.main.injectOutline).toBe(true)
    expect(AGENT_ROLES.main.delegatable).toBe(false)
    expect(AGENT_ROLES.main.constraintDoc).toBeUndefined()
    expect(AGENT_ROLES.main.mergeConfig).toBeUndefined()
  })
})

describe('要素管理员角色声明', () => {
  it('buildSystemPrompt 与 buildElementManagerSystemPrompt 同参输出一致（system.md 被忽略）', () => {
    const viaRole = AGENT_ROLES['element-manager'].buildSystemPrompt({
      model: 'qwen-max',
      systemPrompt: '主角色的 system.md 不进要素管理员上下文',
    })
    expect(viaRole).toBe(buildElementManagerSystemPrompt({ model: 'qwen-max' }))
  })

  it('工具面 = 白名单七件（无委派工具，防递归）', () => {
    const names = toolNames(AGENT_ROLES['element-manager'].createTools())
    expect(names.sort()).toEqual([
      'CreateFile', 'EditFile', 'FindFiles', 'ListDirectory',
      'RagSearch', 'ReadFile', 'RenameFile',
    ])
    expect(names).not.toContain('DelegateToElementManager')
    expect(names).not.toContain('DeleteFile')
    expect(names).not.toContain('WebSearch')
  })

  it('wrapUserContent 走裸文本（不包主角色用户上下文）', () => {
    expect(AGENT_ROLES['element-manager'].wrapUserContent({
      instruction: '整理要素库',
      project: stubProject,
      target: null,
    })).toBe('整理要素库')
  })

  it('注入面声明：不注入项目记忆与大纲；可被委派；有约束文档', () => {
    const role = AGENT_ROLES['element-manager']
    expect(role.injectNovaiOverview).toBe(false)
    expect(role.injectOutline).toBe(false)
    expect(role.delegatable).toBe(true)
    expect(role.constraintDoc?.path).toBe('prompts/ELEMENT.md')
  })

  it('mergeConfig 声明指向要素管理员配置合成（覆盖生效、无覆盖块原样返回）', () => {
    const base = {
      llm: { baseUrl: 'https://a', apiKey: 'k', model: 'main-model' },
      settings: { permissionPreset: 'default' },
    } as unknown as ProjectConfig
    const withOverride = {
      ...base,
      elementManager: {
        llm: { model: 'em-model' },
        permissionPreset: 'readonly',
      },
    } as unknown as ProjectConfig

    expect(AGENT_ROLES['element-manager'].mergeConfig).toBe(mergeElementManagerOverrides)
    expect(AGENT_ROLES['element-manager'].mergeConfig!(base)).toBe(base)
    const merged = AGENT_ROLES['element-manager'].mergeConfig!(withOverride)
    expect(merged.llm.model).toBe('em-model')
    expect(merged.settings.permissionPreset).toBe('readonly')
  })
})
