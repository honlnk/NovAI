import { describe, expect, it } from 'vitest'

import { buildAgentSystemPrompt, buildAgentUserContext } from './prompt'
import { DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_SYSTEM_PROMPT } from '../project/defaults'
import { hashContent } from '../util/hash'

describe('buildAgentSystemPrompt', () => {
  it('builds identity line with model name when provided', () => {
    const prompt = buildAgentSystemPrompt({ model: 'deepseek-chat' })
    expect(prompt).toContain('你是 NovAI，一个使用 deepseek-chat 模型驱动的小说创作 AI 智能体。')
  })

  it('falls back to modelless identity when model is empty', () => {
    const prompt = buildAgentSystemPrompt({ model: '  ' })
    expect(prompt).toContain('你是 NovAI，一个小说创作 AI 智能体。')
    expect(prompt).not.toContain('模型驱动')
  })

  it('states the fixed project structure as facts', () => {
    const prompt = buildAgentSystemPrompt()
    for (const fact of [
      'chapters/：章节正文',
      'characters/：人物，一人一文件',
      'locations/：地点，一地一文件',
      'entities/：具体实体',
      'plots/：剧情事件',
      'timeline/：时间线阶段',
      'worldbuilding/：世界观',
      'prompts/：提示词文件',
      '.novel/：应用内部数据',
      '工具使用规则',
    ]) {
      expect(prompt).toContain(fact)
    }
  })

  it('drops the working-principles column and its overreach phrasings', () => {
    const prompt = buildAgentSystemPrompt()
    // 原则栏整栏砍掉（诊断 §8.2/§8.4 的病灶：任务预设、「该落盘」推力、每轮建议整理要素库）
    expect(prompt).not.toContain('工作原则')
    expect(prompt).not.toContain('你的工作不是把所有正文都堆到聊天里')
    expect(prompt).not.toContain('都应保存在项目文件系统中')
    expect(prompt).not.toContain('每轮收尾')
    expect(prompt).not.toContain('建议整理要素库')
    expect(prompt).not.toContain('不要把完整长篇正文当作唯一结果留在聊天里')
    // 要素分组从指令句改为结构事实陈述句
    expect(prompt).not.toContain('人物写入 elements/characters')
  })

  it('does not inject system.md when it is the untouched default template', () => {
    const prompt = buildAgentSystemPrompt({ systemPrompt: DEFAULT_SYSTEM_PROMPT })
    expect(prompt).not.toContain('注：本文件当前为提示词模板')
    expect(prompt).not.toContain('保持节奏可控')
  })

  it('does not inject system.md when it is the untouched legacy default template', () => {
    // 旧项目从未改过的 prompts/system.md 仍是旧模板文本，同样视为「未修改」
    const prompt = buildAgentSystemPrompt({ systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPT })
    expect(prompt).not.toContain('# SYSTEM Prompt')
    expect(prompt).not.toContain('文件格式约定')
  })

  it('injects modified system.md after the fixed sections', () => {
    const custom = '- 内容：禁止血腥暴力描写。'
    const prompt = buildAgentSystemPrompt({ systemPrompt: custom })
    expect(prompt).toContain(custom)
    // 后置拼接：在工具使用规则之后（结构说明与工具规则都是固定段）
    expect(prompt.indexOf(custom)).toBeGreaterThan(prompt.indexOf('工具使用规则'))
  })

  it('treats whitespace-only system.md as absent', () => {
    const prompt = buildAgentSystemPrompt({ systemPrompt: '   \n  ' })
    // 空白内容不注入：全文不出现分隔线，也不出现任何模板文本
    expect(prompt).not.toContain('---')
    expect(prompt).not.toContain('保持节奏可控')
  })

  it('produces different hash when model or modified systemPrompt changes', () => {
    // systemPromptHash 随身份（含模型名）与 system.md 实际注入内容变化——缓存友好的刷新机制
    const base = buildAgentSystemPrompt({ model: 'deepseek-chat' })
    const otherModel = buildAgentSystemPrompt({ model: 'glm-5' })
    const withCustom = buildAgentSystemPrompt({
      model: 'deepseek-chat',
      systemPrompt: '- 内容：禁止血腥暴力描写。',
    })
    expect(hashContent(base)).not.toBe(hashContent(otherModel))
    expect(hashContent(base)).not.toBe(hashContent(withCustom))
    // 默认模板不注入 → 与未传 systemPrompt 的 hash 一致（同模型下 system 恒定）
    expect(hashContent(buildAgentSystemPrompt({ model: 'deepseek-chat', systemPrompt: DEFAULT_SYSTEM_PROMPT })))
      .toBe(hashContent(base))
  })
})

describe('buildAgentUserContext', () => {
  it('drops the per-turn write-tool tail sentence', () => {
    // 诊断 §3.3：每轮 user 尾巴「若需要写文件，直接调用合适的文件工具」持续强化写推力，整句删除
    const content = buildAgentUserContext({
      instruction: '查一下 李世民身世',
      project: { name: '测试项目' } as never,
      target: null,
    })
    expect(content).toContain('用户意图：查一下 李世民身世')
    expect(content).toContain('当前项目：测试项目')
    expect(content).not.toContain('请按照系统要求')
    expect(content).not.toContain('直接调用合适的文件工具')
  })

  it('keeps quote block when provided', () => {
    const content = buildAgentUserContext({
      instruction: '续写这段',
      quote: '夜色如墨。',
      project: { name: '测试项目' } as never,
      target: null,
    })
    expect(content).toContain('用户引用的内容：')
    expect(content).toContain('夜色如墨。')
  })
})
