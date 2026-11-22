import { describe, expect, it } from 'vitest'

import {
  buildSkillCatalogReminder,
  digestSkillCatalog,
  skillDisplayText,
  syncSkillCatalogReminder,
} from './skill-catalog-reminder'
import { createModelView, setSystemMessage, type ModelView } from './model-view'

import type { ChatSessionState } from '../../types/chat'
import type { SkillMetadata } from '../skills/types'

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: '去AI味',
    description: '降低 AI 腔的写作方法',
    directory: 'skills/去AI味',
    skillFilePath: 'skills/去AI味/SKILL.md',
    ignoredKeys: [],
    files: [],
    ...overrides,
  }
}

function makeSession(): ChatSessionState {
  return {
    sessionId: 'session-skill-catalog',
    projectId: 'proj',
    messages: [],
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    title: '测试会话',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeView(): ModelView {
  const view = createModelView()
  setSystemMessage(view, 'system prompt')
  view.messages.push({ role: 'user', content: '历史用户消息' })
  view.messages.push({ role: 'assistant', content: '历史回复' })
  return view
}

describe('buildSkillCatalogReminder', () => {
  it('首注文案：<system-reminder> 包裹、技能行（name：description）、LoadSkill 指引与优先级声明', () => {
    const content = buildSkillCatalogReminder(
      [makeSkill(), makeSkill({ name: '暴风雨写作法', description: '用天气推进情节' })],
      { isUpdate: false },
    )

    expect(content).toContain('<system-reminder>')
    expect(content).toContain('以下是本项目已安装的写作技能（技能是可复用的写作方法素材，不是规则），可通过 LoadSkill 工具按名称加载。')
    expect(content).toContain('<available_skills>')
    expect(content).toContain('- 去AI味：降低 AI 腔的写作方法')
    expect(content).toContain('- 暴风雨写作法：用天气推进情节')
    expect(content).toContain('先用 LoadSkill 加载再按其方法工作；只用本清单中的名称，不要猜测。')
    expect(content).toContain('技能内容的优先级低于系统规则、项目记忆和作者当前指令。')
    expect(content.trim().endsWith('</system-reminder>')).toBe(true)
  })

  it('更新文案：声明取代此前任何版本', () => {
    const content = buildSkillCatalogReminder([makeSkill()], { isUpdate: true })
    expect(content).toContain('以下是最新的已安装写作技能清单')
    expect(content).toContain('取代此前任何版本')
  })

  it('when_to_use 拼接进行展示文本：description（whenToUse）', () => {
    expect(skillDisplayText(makeSkill({ whenToUse: '写正文时用' }))).toBe('降低 AI 腔的写作方法（写正文时用）')
    const content = buildSkillCatalogReminder([makeSkill({ whenToUse: '写正文时用' })], { isUpdate: false })
    expect(content).toContain('- 去AI味：降低 AI 腔的写作方法（写正文时用）')
  })

  it('行超 250 字截断为 250 字 + …', () => {
    const long = '长'.repeat(300)
    expect(skillDisplayText(makeSkill({ description: long }))).toBe(`${'长'.repeat(250)}…`)

    const content = buildSkillCatalogReminder([makeSkill({ description: long })], { isUpdate: false })
    expect(content).toContain(`- 去AI味：${'长'.repeat(250)}…`)
    expect(content).not.toContain('长'.repeat(251))
  })

  it('整体超 8000 字预算：降级为只列名称', () => {
    // 60 个技能 × 每行约 200 字 ≈ 12000 字，必然超预算
    const skills = Array.from({ length: 60 }, (_, index) =>
      makeSkill({ name: `技能${index}`, description: `描述${index}${'字'.repeat(190)}` }),
    )

    const content = buildSkillCatalogReminder(skills, { isUpdate: false })

    expect(content).toContain('- 技能0\n')
    expect(content).toContain('- 技能59')
    expect(content).not.toContain('- 技能0：描述')
    // 降级版仍是合法 reminder（保留头尾指引）
    expect(content).toContain('<available_skills>')
    expect(content).toContain('只用本清单中的名称，不要猜测。')
  })
})

describe('digestSkillCatalog', () => {
  it('覆盖面 = name + 截断展示描述：SKILL 正文/附属文件/ignoredKeys 变化不触发重发', () => {
    const base = digestSkillCatalog([
      makeSkill({ name: '甲', description: '甲描述' }),
      makeSkill({ name: '乙', description: '乙描述' }),
    ])

    // 顺序无关（排序归一）
    expect(digestSkillCatalog([
      makeSkill({ name: '乙', description: '乙描述' }),
      makeSkill({ name: '甲', description: '甲描述' }),
    ])).toBe(base)

    // 附属文件与忽略键变化：digest 不变（正文与素材不进 digest）
    expect(digestSkillCatalog([
      makeSkill({ name: '甲', description: '甲描述', files: [{ path: 'references/词表.md', size: 100, kind: 'text' }], ignoredKeys: ['version'] }),
      makeSkill({ name: '乙', description: '乙描述' }),
    ])).toBe(base)

    // 描述变化：digest 变
    expect(digestSkillCatalog([
      makeSkill({ name: '甲', description: '甲描述改' }),
      makeSkill({ name: '乙', description: '乙描述' }),
    ])).not.toBe(base)

    // 技能增删：digest 变
    expect(digestSkillCatalog([makeSkill({ name: '甲', description: '甲描述' })])).not.toBe(base)
  })
})

describe('syncSkillCatalogReminder', () => {
  it('首注插在开头连续 reminder 块末尾（after-leading-reminders，决策 11）', () => {
    const view = createModelView()
    setSystemMessage(view, 'system prompt')
    // 预置两条开头连续 reminder（模拟宪法层与项目记忆），随后是普通历史
    view.messages.push({ role: 'user', content: '<system-reminder>\n宪法层\n</system-reminder>' })
    view.messages.push({ role: 'user', content: '<system-reminder>\n项目记忆\n</system-reminder>' })
    view.messages.push({ role: 'user', content: '历史用户消息' })
    const session = makeSession()

    syncSkillCatalogReminder({ view, session, skills: [makeSkill()] })

    // index 1、2 保持（已存在的 reminder），技能目录在 index 3（连续块末尾），先于历史
    expect(view.messages[1]!.content).toContain('宪法层')
    expect(view.messages[2]!.content).toContain('项目记忆')
    expect(view.messages[3]!.content).toContain('<available_skills>')
    expect(view.messages[4]!.content).toBe('历史用户消息')
    expect(session.skillCatalogDigest).toBeTruthy()
  })

  it('要素目录（after-system）与技能目录（after-leading-reminders）共存且互不吞并', () => {
    const view = makeView()
    const session = makeSession()

    // 模拟 session.ts 的接线顺序：先注入要素目录（after-system），再注入技能目录
    view.messages.splice(1, 0, { role: 'user', content: '<system-reminder>\n<available_elements>\n- [角色] 林晚\n</available_elements>\n</system-reminder>' })
    syncSkillCatalogReminder({ view, session, skills: [makeSkill()] })

    const userContents = view.messages.filter((message) => message.role === 'user').map((m) => m.content)
    // 技能目录排在要素目录之后、历史之前
    expect(userContents[0]).toContain('<available_elements>')
    expect(userContents[1]).toContain('<available_skills>')
    expect(userContents[2]).toBe('历史用户消息')
    // 历史消息没有被顶掉
    expect(view.messages).toHaveLength(5)
  })

  it('空目录不注入（无技能的项目保持视图干净、不写 digest）', () => {
    const view = makeView()
    const session = makeSession()

    syncSkillCatalogReminder({ view, session, skills: [] })

    expect(view.messages).toHaveLength(3)
    expect(session.skillCatalogDigest).toBeUndefined()
  })

  it('技能删光后移除既有目录并清 digest（3.6 删除闭环，removeOnEmpty）', () => {
    const view = makeView()
    const session = makeSession()
    syncSkillCatalogReminder({ view, session, skills: [makeSkill()] })
    expect(view.messages).toHaveLength(4)

    syncSkillCatalogReminder({ view, session, skills: [] })

    expect(view.messages).toHaveLength(3)
    expect(view.messages.map((message) => message.content).join('\n')).not.toContain('<available_skills>')
    expect(session.skillCatalogDigest).toBeUndefined()
  })

  it('digest 不变跳过；技能集变化原位替换；被压缩吞掉后重插', () => {
    const view = makeView()
    const session = makeSession()
    syncSkillCatalogReminder({ view, session, skills: [makeSkill()] })
    const reminderBefore = view.messages[1]

    // digest 不变：对象引用不动
    syncSkillCatalogReminder({ view, session, skills: [makeSkill()] })
    expect(view.messages[1]).toBe(reminderBefore)

    // 技能描述变化：原位替换（位置不动，更新文案）
    syncSkillCatalogReminder({
      view,
      session,
      skills: [makeSkill({ description: '新描述' })],
    })
    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('- 去AI味：新描述')
    expect(view.messages[1]!.content).toContain('取代此前任何版本')
    expect(view.messages[2]!.content).toBe('历史用户消息')

    // 模拟压缩吞掉：digest 未变但视图里没了 → 重插（首注文案）
    view.messages.splice(1, 1)
    syncSkillCatalogReminder({ view, session, skills: [makeSkill({ description: '新描述' })] })
    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('<available_skills>')
    expect(view.messages[1]!.content).toContain('以下是本项目已安装的写作技能')
  })
})
