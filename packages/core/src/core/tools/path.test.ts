import { describe, expect, it } from 'vitest'
import {
  internalPathError,
  isAgentHiddenEntry,
  isInternalPath,
  isProtectedLedgerPath,
  isSkillPath,
  isSpillReadablePath,
  protectedLedgerPathError,
  shouldSkipInWalk,
} from './path'

describe('内部路径判定（单一来源，大小写折叠）', () => {
  it.each([
    ['novel.config.json'],
    ['.novel'],
    ['.novai'],
    ['.novel/trash/20260101/chapters/第001章.md'],
    ['.novel/sessions/s1.json'],
    ['.novai/session-state.json'],
    ['.novel/spill/abc.txt'],
    // APFS 大小写不敏感变体
    ['Novel.Config.JSON'],
    ['.NOVEL'],
    ['.Novai/State.json'],
    ['.Novel/Spill/abc.txt'],
  ])('isInternalPath("%s") 为 true', (path) => {
    expect(isInternalPath(path)).toBe(true)
  })

  it.each([
    [''],
    ['chapters/第001章-初遇.txt'],
    ['elements/characters/林婉儿.md'],
    // 名字相近但不是内部路径：子目录里的同名文件、.novel 开头的普通文件
    ['elements/novel.config.json'],
    ['.novel.md'],
    ['novel.config.json.bak'],
  ])('isInternalPath("%s") 为 false', (path) => {
    expect(isInternalPath(path)).toBe(false)
  })
})

describe('spill 取回通道放行判定', () => {
  it.each([
    ['.novel/spill'],
    ['.novel/spill/abc.txt'],
    ['.novel/spill/search-files-x1.txt'],
    ['.NOVEL/SPILL/abc.txt'],
  ])('isSpillReadablePath("%s") 为 true', (path) => {
    expect(isSpillReadablePath(path)).toBe(true)
  })

  it.each([
    ['.novel'],
    ['.novai/spill/abc.txt'], // 只有 .novel/spill 是例外，.novai 没有取回通道
    ['.novel/spills/abc.txt'], // 前缀撞名不算（spills ≠ spill）
    ['.novel/trash/x.md'],
    ['chapters/abc.txt'],
  ])('isSpillReadablePath("%s") 为 false', (path) => {
    expect(isSpillReadablePath(path)).toBe(false)
  })
})

describe('目录条目隐藏判定（ListDirectory 用）', () => {
  it.each([
    ['.git'],
    ['.DS_Store'],
    ['.novel'],
    ['.novai'],
    ['novel.config.json'],
    ['Novel.Config.JSON'],
  ])('isAgentHiddenEntry("%s") 为 true（对模型不可见）', (entryName) => {
    expect(isAgentHiddenEntry(entryName)).toBe(true)
  })

  it.each([
    ['chapters'],
    ['elements'],
    ['prompts'],
    ['第001章-初遇.txt'],
    ['outline.md'],
  ])('isAgentHiddenEntry("%s") 为 false', (entryName) => {
    expect(isAgentHiddenEntry(entryName)).toBe(false)
  })
})

describe('遍历跳过判定（walkFiles 用，目录命中即整棵子树跳过）', () => {
  it.each([
    ['novel.config.json'],
    ['Novel.Config.JSON'],
    ['.novel'],
    ['.novel/trash/20260101/chapters/第001章.md'],
    ['.novai/state.json'],
    // 常规隐藏项：任意深度的点开头条目照旧跳过
    ['.git/config'],
    ['.DS_Store'],
    ['chapters/.draft.md'],
    ['elements/.staging/林婉儿.md'],
  ])('shouldSkipInWalk("%s") 为 true', (path) => {
    expect(shouldSkipInWalk(path)).toBe(true)
  })

  it.each([
    ['.novel/spill/abc.txt'],
    ['.NOVEL/Spill/search-files-x1.txt'],
    ['chapters/第001章-初遇.txt'],
    ['elements/characters/林婉儿.md'],
    ['plans/大纲.md'],
  ])('shouldSkipInWalk("%s") 为 false（spill 子树永不跳过）', (path) => {
    expect(shouldSkipInWalk(path)).toBe(false)
  })
})

describe('internalPathError 教学式报错（D5：边界 + 原因 + 出路）', () => {
  it('报错以参数标签开头，完整陈述边界、密钥原因与出路', () => {
    const message = internalPathError('ReadFile.path').message

    expect(message.startsWith('ReadFile.path 不能指向应用内部文件。')).toBe(true)
    expect(message).toContain('novel.config.json（项目配置，含模型密钥）、.novel/、.novai/ 由应用自行管理')
    expect(message).toContain('不会出现在目录列表和搜索结果中')
    expect(message).toContain('唯一例外是 .novel/spill/（超长工具结果的取回通道，可按指引用 ReadFile 分段读取）')
    expect(message).toContain('模型名与默认目标已在每条用户指令的上下文中给出，其余请直接询问用户，不要尝试读取配置文件')
  })
})

describe('受保护账本判定（关系账本，单一来源，大小写折叠）', () => {
  it.each([
    ['elements/relations.json'],
    ['Elements/Relations.JSON'],
    ['ELEMENTS/RELATIONS.json'],
  ])('isProtectedLedgerPath("%s") 为 true', (path) => {
    expect(isProtectedLedgerPath(path)).toBe(true)
  })

  it.each([
    ['elements/relations.json.bak'],
    ['elements/characters/relations.json'], // 子目录同名文件不受保护（按名字精确匹配路径）
    ['relations.json'],
    ['elements/relations.md'],
    ['elements/characters/林澜.md'],
    [''],
  ])('isProtectedLedgerPath("%s") 为 false', (path) => {
    expect(isProtectedLedgerPath(path)).toBe(false)
  })

  it('账本不是内部路径（两类保护分开判定），但遍历同样跳过', () => {
    expect(isInternalPath('elements/relations.json')).toBe(false)
    expect(isProtectedLedgerPath('elements/relations.json')).toBe(true)
    expect(shouldSkipInWalk('elements/relations.json')).toBe(true)
    // 名字判定不命中（ListDirectory 由调用方带全路径补判）
    expect(isAgentHiddenEntry('relations.json')).toBe(false)
  })

  it('protectedLedgerPathError 教学式报错：边界 + 专用工具出路', () => {
    const message = protectedLedgerPathError('ReadFile.path', 'elements/relations.json').message

    expect(message.startsWith('ReadFile.path 不能指向关系账本文件（elements/relations.json）。')).toBe(true)
    expect(message).toContain('查询用 RelationList / RelationQuery / RelationRead')
    expect(message).toContain('登记与修改用 RelationCreate / RelationUpdate / RelationDelete')
    expect(message).toContain('检查数据用 RelationCheck')
    expect(message).toContain('该文件不会出现在目录列表与搜索结果中')
  })
})

describe('受保护账本判定（时间线账本，阶段 1 接入）', () => {
  it.each([
    ['elements/timeline.json'],
    ['Elements/Timeline.JSON'],
  ])('isProtectedLedgerPath("%s") 为 true', (path) => {
    expect(isProtectedLedgerPath(path)).toBe(true)
  })

  it.each([
    ['elements/timeline.json.bak'],
    ['elements/timeline/第001章-开局.md'], // 旧时间线目录不受账本保护（阶段 4 退役）
    ['timeline.json'],
  ])('isProtectedLedgerPath("%s") 为 false', (path) => {
    expect(isProtectedLedgerPath(path)).toBe(false)
  })

  it('遍历跳过，但不是内部路径', () => {
    expect(isInternalPath('elements/timeline.json')).toBe(false)
    expect(shouldSkipInWalk('elements/timeline.json')).toBe(true)
  })

  it('protectedLedgerPathError 按账本分支指路时间线六工具', () => {
    const message = protectedLedgerPathError('ReadFile.path', 'elements/timeline.json').message

    expect(message.startsWith('ReadFile.path 不能指向时间线账本文件（elements/timeline.json）。')).toBe(true)
    expect(message).toContain('查询与浏览用 TimelineList / TimelineRead')
    expect(message).toContain('登记事件用 TimelineCreatePoint / TimelineCreateSpan')
    expect(message).toContain('修改与移动用 TimelineUpdate，删除用 TimelineDelete')
    expect(message).toContain('时间轴弹窗与这些工具操作同一份数据')
  })
})


describe('技能包路径判定（3.6：skills/ 是普通可管理目录，大小写折叠）', () => {
  it.each([
    'skills/去AI味/SKILL.md',
    'skills/去AI味/references/词表.md',
    'SKILLS/去AI味/SKILL.md',
    'Skills/技能/SKILL.md',
  ])('isSkillPath("%s") 为 true', (path) => {
    expect(isSkillPath(path)).toBe(true)
  })

  it.each([
    'skills', // 裸目录名不算文件路径（ReadFile 只作用于文件）
    'chapters/第001章-试炼.txt',
    'prompts/skills.md', // 同名文件不受前缀误伤
    'elements/characters/skills.md',
  ])('isSkillPath("%s") 为 false', (path) => {
    expect(isSkillPath(path)).toBe(false)
  })

  it('技能路径不是内部路径也不是受保护账本（普通目录：读写照常）', () => {
    const skillFile = 'skills/去AI味/SKILL.md'
    expect(isInternalPath(skillFile)).toBe(false)
    expect(isProtectedLedgerPath(skillFile)).toBe(false)
    expect(shouldSkipInWalk(skillFile)).toBe(false)
  })
})
