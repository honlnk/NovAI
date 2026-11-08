import { describe, expect, it } from 'vitest'

import {
  buildRhythmBody,
  parseRhythmFile,
  replaceRhythmBodySections,
  serializeRhythmCard,
  splitRhythmBody,
  toRhythmCardView,
} from './parser'
import { RhythmError } from '../../types/rhythm'
import type { RhythmCard } from '../../types/rhythm'

function baseCard(overrides: Partial<Omit<RhythmCard, 'sourcePath'>> = {}): Omit<RhythmCard, 'sourcePath'> {
  return {
    id: 'R-083',
    name: '第083章节奏',
    status: 'written',
    order: 100,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    chapterRef: '第二卷/第083章',
    volume: '第二卷',
    plannedConflict: 3,
    plannedMood: '温馨',
    plannedHook: '无',
    plannedPayoff: '收获',
    plannedCharacters: ['主角', '师妹'],
    plannedNote: '大高潮后的喘息章',
    actualConflict: 7,
    actualMood: '悲壮',
    actualHook: '悬念',
    actualPayoff: '收获',
    actualNote: '写着写着打起来了',
    deviationFlag: true,
    deviationNote: '冲突强度偏差：计划 3 实际 7',
    body: buildRhythmBody(
      '大高潮（第 82 章悲壮决战）之后必须让读者喘口气。',
      '- 上一章（第 82 章）：冲突 9、悲壮、情感爆发\n- 下一章（第 84 章）：计划冲突 4、轻松、悬念',
      '自由文本备注',
    ),
    ...overrides,
  }
}

describe('parseRhythmFile', () => {
  it('解析标准节奏卡文件（计划值/实际值/偏差标记 + 三节正文）', () => {
    const content = serializeRhythmCard(baseCard())
    const parsed = parseRhythmFile('rhythm/R-083-第083章节奏.md', content)

    expect(parsed.card).toEqual(baseCard())
    expect(parsed.contentHash).toBeTruthy()
    expect(parsed.intentBody).toBe('大高潮（第 82 章悲壮决战）之后必须让读者喘口气。')
    expect(parsed.linkBody).toContain('上一章（第 82 章）')
    expect(parsed.authorNoteBody).toBe('自由文本备注')
  })

  it('解析计划文档同款 frontmatter（含 # 分组注释行）', () => {
    const content = [
      '---',
      'id: R-083',
      'name: 第083章节奏',
      'status: planned',
      'chapter_ref: 第二卷/第083章',
      'volume: 第二卷',
      '# 计划值（作者/AI 规划时填写）',
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      'planned_characters: [主角, 师妹]',
      'planned_note: "大高潮后的喘息章，回家吃饭、整理战利品、闲聊"',
      '# 实际值（写完后回写）',
      'actual_conflict: null',
      'actual_mood: null',
      'actual_hook: null',
      'actual_payoff: null',
      'actual_note: null',
      '# 偏差标记',
      'deviation_flag: false',
      'deviation_note: null',
      '---',
      '',
      '## 节奏意图',
      '',
      '喘口气。',
    ].join('\n')

    const parsed = parseRhythmFile('rhythm/R-083-第083章节奏.md', content)

    expect(parsed.card.id).toBe('R-083')
    expect(parsed.card.plannedCharacters).toEqual(['主角', '师妹'])
    expect(parsed.card.plannedNote).toBe('"大高潮后的喘息章，回家吃饭、整理战利品、闲聊"')
    expect(parsed.card.actualConflict).toBeNull()
    expect(parsed.card.deviationFlag).toBe(false)
    expect(parsed.intentBody).toBe('喘口气。')
  })

  it('actual_* 缺省 null、deviation_flag 缺省 false、planned_characters 缺省空数组', () => {
    const content = [
      '---',
      'id: R-001',
      'name: x',
      'planned_conflict: 5',
      'planned_mood: 平静',
      'planned_hook: 悬念',
      'planned_payoff: 无',
      '---',
      '',
      '## 节奏意图',
      '',
      '正文',
    ].join('\n')

    const parsed = parseRhythmFile('rhythm/x.md', content)

    expect(parsed.card.status).toBe('planned')
    expect(parsed.card.chapterRef).toBe('')
    expect(parsed.card.volume).toBe('')
    expect(parsed.card.plannedCharacters).toEqual([])
    expect(parsed.card.plannedNote).toBe('')
    expect(parsed.card.actualConflict).toBeNull()
    expect(parsed.card.actualMood).toBeNull()
    expect(parsed.card.actualHook).toBeNull()
    expect(parsed.card.actualPayoff).toBeNull()
    expect(parsed.card.actualNote).toBeNull()
    expect(parsed.card.deviationFlag).toBe(false)
    expect(parsed.card.deviationNote).toBeNull()
    expect(parsed.card.order).toBe(0)
  })

  it('volume 缺失时从 chapter_ref 首个 / 前段推导', () => {
    const card = baseCard({ volume: '' })
    const parsed = parseRhythmFile('rhythm/x.md', serializeRhythmCard(card))
    expect(parsed.card.volume).toBe('第二卷')
  })

  it('非法情绪基调抛错并指明字段（扫描层收进 issue）', () => {
    const card = baseCard()
    const content = serializeRhythmCard(card).replace('planned_mood: 温馨', 'planned_mood: 豪横')

    expect(() => parseRhythmFile('rhythm/x.md', content)).toThrow(RhythmError)
    expect(() => parseRhythmFile('rhythm/x.md', content)).toThrow('planned_mood 非法：豪横')
  })

  it('计划值缺失抛错（必填、无合理默认）', () => {
    const full = [
      '---',
      'id: R-001',
      'name: x',
      'planned_conflict: 5',
      'planned_mood: 平静',
      'planned_hook: 悬念',
      'planned_payoff: 无',
      '---',
      '',
      '正文',
    ].join('\n')

    expect(() => parseRhythmFile('rhythm/x.md', full.replace('planned_conflict: 5\n', ''))).toThrow('planned_conflict 缺失')
    expect(() => parseRhythmFile('rhythm/x.md', full.replace('planned_mood: 平静\n', ''))).toThrow('planned_mood 缺失')
    expect(() => parseRhythmFile('rhythm/x.md', full.replace('planned_hook: 悬念\n', ''))).toThrow('planned_hook 缺失')
    expect(() => parseRhythmFile('rhythm/x.md', full.replace('planned_payoff: 无\n', ''))).toThrow('planned_payoff 缺失')
  })

  it('冲突强度越界/非整数按非法处理（planned 与 actual 同口径）', () => {
    const content = serializeRhythmCard(baseCard())

    expect(() => parseRhythmFile('rhythm/x.md', content.replace('planned_conflict: 3', 'planned_conflict: 11')))
      .toThrow('planned_conflict 非法：11')
    expect(() => parseRhythmFile('rhythm/x.md', content.replace('planned_conflict: 3', 'planned_conflict: 0')))
      .toThrow('planned_conflict 非法：0')
    expect(() => parseRhythmFile('rhythm/x.md', content.replace('planned_conflict: 3', 'planned_conflict: 3.5')))
      .toThrow('planned_conflict 非法：3.5')
    expect(() => parseRhythmFile('rhythm/x.md', content.replace('actual_conflict: 7', 'actual_conflict: 99')))
      .toThrow('actual_conflict 非法：99')
  })

  it('非法 actual 枚举抛错；null 合法回 null', () => {
    const content = serializeRhythmCard(baseCard())

    expect(() => parseRhythmFile('rhythm/x.md', content.replace('actual_hook: 悬念', 'actual_hook: 惊讶')))
      .toThrow('actual_hook 非法：惊讶')
    expect(() => parseRhythmFile('rhythm/x.md', content.replace('actual_payoff: 收获', 'actual_payoff: 奖励')))
      .toThrow('actual_payoff 非法：奖励')

    const parsed = parseRhythmFile('rhythm/x.md', content.replace('actual_payoff: 收获', 'actual_payoff: null'))
    expect(parsed.card.actualPayoff).toBeNull()
  })

  it('非法 status 回退 planned（与伏笔 parser 同口径），不丢正文', () => {
    const content = [
      '---',
      'id: R-001',
      'status: 不存在的状态',
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      '---',
      '',
      '## 节奏意图',
      '',
      '正文内容',
    ].join('\n')

    const parsed = parseRhythmFile('rhythm/x.md', content)
    expect(parsed.card.status).toBe('planned')
    expect(parsed.intentBody).toBe('正文内容')
  })
})

describe('serialize/parse 往返', () => {
  it('全字段往返无损（serialize(parse(serialize(card))) 恒等）', () => {
    const card = baseCard()
    const once = serializeRhythmCard(card)
    const twice = serializeRhythmCard(parseRhythmFile('rhythm/x.md', once).card)

    expect(twice).toBe(once)
    expect(parseRhythmFile('rhythm/x.md', twice).card).toEqual(card)
  })

  it('actual 全 null、空列表与空备注往返无损', () => {
    const card = baseCard({
      plannedCharacters: [],
      plannedNote: '',
      actualConflict: null,
      actualMood: null,
      actualHook: null,
      actualPayoff: null,
      actualNote: null,
      deviationFlag: false,
      deviationNote: null,
    })

    const once = serializeRhythmCard(card)
    expect(parseRhythmFile('rhythm/x.md', once).card).toEqual(card)
  })
})

describe('splitRhythmBody', () => {
  it('三节正文按标题拆分', () => {
    const body = buildRhythmBody('意图内容', '衔接内容', '备注内容')
    const result = splitRhythmBody(body)

    expect(result.intentBody).toBe('意图内容')
    expect(result.linkBody).toBe('衔接内容')
    expect(result.authorNoteBody).toBe('备注内容')
  })

  it('衔接/备注节缺失时对应为空串', () => {
    const result = splitRhythmBody('## 节奏意图\n\n只有意图')
    expect(result.intentBody).toBe('只有意图')
    expect(result.linkBody).toBe('')
    expect(result.authorNoteBody).toBe('')
  })

  it('节前导语与未知小节归入节奏意图（主节），内容不丢', () => {
    const body = [
      '随手记一句',
      '',
      '## 节奏意图',
      '',
      '意图内容',
      '',
      '## 其他小节',
      '',
      '未知内容',
    ].join('\n')

    const result = splitRhythmBody(body)
    expect(result.intentBody).toContain('随手记一句')
    expect(result.intentBody).toContain('意图内容')
    expect(result.intentBody).toContain('## 其他小节')
    expect(result.intentBody).toContain('未知内容')
  })
})

describe('replaceRhythmBodySections', () => {
  it('只替换节奏意图，衔接与备注保持原样', () => {
    const body = buildRhythmBody('旧意图', '旧衔接', '旧备注')
    const next = replaceRhythmBodySections(body, { intentBody: '新意图' })
    const parsed = splitRhythmBody(next)

    expect(parsed.intentBody).toBe('新意图')
    expect(parsed.linkBody).toBe('旧衔接')
    expect(parsed.authorNoteBody).toBe('旧备注')
  })

  it('只替换上下文衔接（含空串清除）', () => {
    const body = buildRhythmBody('旧意图', '旧衔接', '旧备注')

    const replaced = replaceRhythmBodySections(body, { linkBody: '新衔接' })
    expect(splitRhythmBody(replaced).linkBody).toBe('新衔接')

    const cleared = replaceRhythmBodySections(body, { linkBody: '' })
    const parsed = splitRhythmBody(cleared)
    expect(parsed.linkBody).toBe('')
    expect(parsed.intentBody).toBe('旧意图')
    expect(parsed.authorNoteBody).toBe('旧备注')
    expect(cleared).not.toContain('## 上下文衔接')
  })

  it('只替换作者备注（含空串清除）', () => {
    const body = buildRhythmBody('旧意图', '旧衔接', '旧备注')

    const replaced = replaceRhythmBodySections(body, { authorNoteBody: '新备注' })
    expect(splitRhythmBody(replaced).authorNoteBody).toBe('新备注')

    const cleared = replaceRhythmBodySections(body, { authorNoteBody: '' })
    expect(splitRhythmBody(cleared).authorNoteBody).toBe('')
    expect(cleared).not.toContain('## 作者备注')
  })
})

describe('toRhythmCardView', () => {
  it('summary 取节奏意图节首个非空行', () => {
    const card = { ...baseCard(), sourcePath: 'rhythm/R-083-x.md' } as RhythmCard
    const view = toRhythmCardView(card)

    expect(view.summary).toBe('大高潮（第 82 章悲壮决战）之后必须让读者喘口气。')
  })

  it('无意图节时 summary 为空串', () => {
    const card = { ...baseCard(), body: '## 上下文衔接\n\n衔接', sourcePath: 'rhythm/x.md' } as RhythmCard
    expect(toRhythmCardView(card).summary).toBe('')
  })
})
