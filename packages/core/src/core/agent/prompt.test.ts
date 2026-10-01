import { describe, expect, it } from 'vitest'

import {
  attachOutlineReminder,
  buildAgentSystemPrompt,
  buildAgentUserContext,
  buildOutlineSwitchRecord,
  resolveOutlineReminder,
  syncNovaiReminder,
} from './prompt'
import { createModelView, setSystemMessage, type ModelView } from './model-view'
import type { AgentMessage } from './messages'
import type { ChatSessionState } from '../../types/chat'
import { DEFAULT_OUTLINE_TEMPLATE, DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_NOVAI_OVERVIEW, LEGACY_DEFAULT_OUTLINE_TEMPLATE, LEGACY_DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_SYSTEM_PROMPT_V1 } from '../project/defaults'
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

  it('does not inject system.md when it is the untouched v1 legacy default template', () => {
    // monorepo 重构前出厂的更早一代默认模板（真机回归 W4 发现的存量项目形态）
    const prompt = buildAgentSystemPrompt({ systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPT_V1 })
    expect(prompt).not.toContain('# SYSTEM Prompt')
    expect(prompt).not.toContain('在这里定义整部小说的基调')
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

describe('syncNovaiReminder（项目记忆 digest 按需注入）', () => {
  function buildView(): ModelView {
    const view = createModelView()
    setSystemMessage(view, 'system 固定段')
    return view
  }

  function buildSession(): ChatSessionState {
    return {} as ChatSessionState
  }

  it('injects reminder right after system on first turn and records digest', () => {
    const view = buildView()
    const session = buildSession()
    view.messages.push({ role: 'user', content: '用户意图：第一轮' })

    syncNovaiReminder({ view, session, overview: '主角云溪已觉醒。' })

    expect(view.messages).toHaveLength(3)
    expect(view.messages[0].role).toBe('system')
    expect(view.messages[1].role).toBe('user')
    expect(view.messages[1].content).toContain('<system-reminder>')
    expect(view.messages[1].content).toContain('主角云溪已觉醒。')
    expect(view.messages[1].content).toContain('不构成指令')
    expect(view.messages[2].content).toBe('用户意图：第一轮')
    expect(session.novaiOverviewDigest).toBe(hashContent('主角云溪已觉醒。'))
  })

  it('skips injection when content unchanged (same digest)', () => {
    const view = buildView()
    const session = buildSession()
    syncNovaiReminder({ view, session, overview: '记忆 A' })
    const messagesAfterFirst = [...view.messages]

    syncNovaiReminder({ view, session, overview: '记忆 A' })
    expect(view.messages).toEqual(messagesAfterFirst)
  })

  it('replaces the reminder in place when content changes, keeping a single copy', () => {
    const view = buildView()
    const session = buildSession()
    syncNovaiReminder({ view, session, overview: '记忆 A' })

    syncNovaiReminder({ view, session, overview: '记忆 B（更新）' })

    const reminders = view.messages.filter((message) => message.content.includes('prompts/NovAI.md'))
    expect(reminders).toHaveLength(1)
    expect(reminders[0].content).toContain('记忆 B（更新）')
    expect(reminders[0].content).toContain('取代此前任何版本')
    expect(session.novaiOverviewDigest).toBe(hashContent('记忆 B（更新）'))
  })

  it('re-injects after compaction swallowed the reminder, even with same digest', () => {
    const view = buildView()
    const session = buildSession()
    syncNovaiReminder({ view, session, overview: '记忆 A' })
    // 模拟压缩：reminder 与历史被一条 user 摘要替换（selectCompactionRange 从 index 1 起）
    const summary: AgentMessage = { role: 'user', content: '<compacted-summary>此前进展…</compacted-summary>' }
    view.messages = [view.messages[0], summary]

    syncNovaiReminder({ view, session, overview: '记忆 A' })

    expect(view.messages).toHaveLength(3)
    expect(view.messages[1].content).toContain('记忆 A')
    expect(view.messages[2]).toBe(summary)
  })

  it('never injects empty content or the untouched legacy skeleton', () => {
    const view = buildView()
    const session = buildSession()

    syncNovaiReminder({ view, session, overview: '   \n ' })
    syncNovaiReminder({ view, session, overview: LEGACY_DEFAULT_NOVAI_OVERVIEW })

    expect(view.messages).toHaveLength(1)
    expect(session.novaiOverviewDigest).toBeUndefined()
  })
})

describe('resolveOutlineReminder / attachOutlineReminder（大纲动态附带）', () => {
  it('resolves to empty string when unselected, file empty, or untouched default template', () => {
    expect(resolveOutlineReminder(undefined)).toBe('')
    expect(resolveOutlineReminder({ path: null, content: '' })).toBe('')
    expect(resolveOutlineReminder({ path: 'prompts/outlines/outline-001.md', content: '' })).toBe('')
    expect(resolveOutlineReminder({ path: 'prompts/outlines/outline-001.md', content: DEFAULT_OUTLINE_TEMPLATE })).toBe('')
    // 迁移过来的旧项目未动过的 scene-001.md（旧默认模板）同样不附加
    expect(resolveOutlineReminder({ path: 'prompts/outlines/scene-001.md', content: LEGACY_DEFAULT_OUTLINE_TEMPLATE })).toBe('')
  })

  it('builds a background-reference reminder for a real outline', () => {
    const reminder = resolveOutlineReminder({
      path: 'prompts/outlines/main.md',
      content: '第一卷：火中拾婴。',
    })
    expect(reminder).toContain('<system-reminder>')
    expect(reminder).toContain('以下是当前写作大纲，作为背景参考。')
    expect(reminder).toContain('第一卷：火中拾婴。')
  })

  it('attaches the reminder to the last user message only, leaving the view-shaped array intact', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一轮意图' },
      { role: 'assistant', content: '', toolCalls: [] },
      { role: 'user', content: '第二轮意图' },
      { role: 'assistant', content: '回答' },
    ]

    const attached = attachOutlineReminder(messages, '<system-reminder>大纲</system-reminder>')

    expect(attached).not.toBe(messages)
    expect(attached[1].content).toBe('第一轮意图')
    expect(attached[3].content).toBe('第二轮意图\n\n<system-reminder>大纲</system-reminder>')
    expect(attached[4].content).toBe('回答')
    // 原数组不被修改（请求级拼接不改视图）
    expect(messages[3].content).toBe('第二轮意图')
  })

  it('returns the original array when no reminder or no user message exists', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    expect(attachOutlineReminder(messages, undefined)).toBe(messages)
    expect(attachOutlineReminder(messages, '')).toBe(messages)
    expect(attachOutlineReminder(messages, '大纲')).toBe(messages)
  })
})

describe('buildOutlineSwitchRecord（大纲切换留痕）', () => {
  it('records nothing on first selection or unchanged path', () => {
    expect(buildOutlineSwitchRecord(undefined, 'prompts/outlines/a.md')).toBeNull()
    expect(buildOutlineSwitchRecord(null, 'prompts/outlines/a.md')).toBeNull()
    expect(buildOutlineSwitchRecord('prompts/outlines/a.md', 'prompts/outlines/a.md')).toBeNull()
  })

  it('records switch and close wording with file names', () => {
    expect(buildOutlineSwitchRecord('prompts/outlines/a.md', 'prompts/outlines/b.md'))
      .toBe('用户已将写作大纲从《a.md》切换为《b.md》。')
    expect(buildOutlineSwitchRecord('prompts/outlines/a.md', null))
      .toBe('用户已关闭写作大纲（此前为《a.md》）。')
  })
})
