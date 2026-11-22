import { describe, expect, it } from 'vitest'

import { collectSkillMentions, expandSkillMentions } from './skill-mention'

const NAMES = ['去AI味', '文风仿写', '节奏控制']

describe('collectSkillMentions 命中与去重', () => {
  it('命中名单的 #技能名 收集；同名去重、保持出现顺序', () => {
    expect(collectSkillMentions('#文风仿写 先 #去AI味 再 #文风仿写', NAMES)).toEqual(['文风仿写', '去AI味'])
  })

  it('中文标点紧跟的 #技能名 不算完整 token（与 @大纲 同规则：须空白或结尾收尾）', () => {
    // `#去AI味，` 的 token 会吃掉「，再」直到空白，不在名单 → 不命中
    expect(collectSkillMentions('#去AI味，帮我改这段', NAMES)).toEqual([])
  })

  it('名单外的 #X 不收集（话题标签、未加载完的技能）', () => {
    expect(collectSkillMentions('#去AI味 #日常 #文风仿写', NAMES)).toEqual(['去AI味', '文风仿写'])
    expect(collectSkillMentions('#随便什么 话题标签', NAMES)).toEqual([])
  })

  it('`# 标题` 与句中紧跟文字的 `#X` 都不算完整 token', () => {
    // Markdown 标题：# 后紧跟空格，name 为空不触发
    expect(collectSkillMentions('# 标题文字\n#去AI味 改这段', NAMES)).toEqual(['去AI味'])
    // #X 后紧跟非空白（未打完空格）：token 未闭合不命中
    expect(collectSkillMentions('#去AI味帮我改这段', NAMES)).toEqual([])
    // 句中无空白前导的 # 不触发（与 @大纲 同规则）
    expect(collectSkillMentions('句子里#去AI味 的写法', NAMES)).toEqual([])
  })

  it('##双井号与 @ / 触发符不互相干扰', () => {
    expect(collectSkillMentions('##小标题 #去AI味', NAMES)).toEqual(['去AI味'])
    expect(collectSkillMentions('去AI味@主线 #节奏控制', NAMES)).toEqual(['节奏控制'])
  })
})

describe('expandSkillMentions 发送展开', () => {
  it('命中的点名汇总为一句追加到末尾（顿号连接，保持顺序）', () => {
    const result = expandSkillMentions('#去AI味 帮我改这段，顺带 #文风仿写', NAMES)
    expect(result).toBe(
      '#去AI味 帮我改这段，顺带 #文风仿写\n\n（作者点名使用技能：去AI味、文风仿写。请先用 LoadSkill 逐个加载，再按技能方法完成本条请求。）',
    )
  })

  it('无命中原样返回（内容零改动，displayLabel 判定不受影响）', () => {
    const text = '#话题标签 只是正文'
    expect(expandSkillMentions(text, NAMES)).toBe(text)
  })

  it('斜杠展开结果之后再追加技能句（调用方组合顺序：slash 先、skill 后）', () => {
    const slashExpanded = '【管理要素驱动 prompt】\n\n顺带 #去AI味'
    const result = expandSkillMentions(slashExpanded, NAMES)
    expect(result.startsWith(slashExpanded)).toBe(true)
    expect(result).toContain('（作者点名使用技能：去AI味。')
  })

  it('同技能多次点名只提示一次', () => {
    const result = expandSkillMentions('#去AI味 第一段\n\n#去AI味 第二段', NAMES)
    expect(result.match(/去AI味/g)).toHaveLength(3) // 两个标签 + 点名句一次
  })
})
