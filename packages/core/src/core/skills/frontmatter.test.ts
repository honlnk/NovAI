import { describe, expect, it } from 'vitest'

import { parseSkillFile } from './frontmatter'

describe('parseSkillFile', () => {
  it('基础扁平键：name/description/when_to_use', () => {
    const result = parseSkillFile([
      '---',
      'name: 去AI味',
      'description: 一句话说明做什么',
      'when_to_use: 写正文时用',
      '---',
      '',
      '# 正文',
      '内容',
    ].join('\n'))

    expect(result).toMatchObject({
      ok: true,
      hasFrontmatter: true,
      frontmatter: {
        name: '去AI味',
        description: '一句话说明做什么',
        whenToUse: '写正文时用',
      },
      ignoredKeys: [],
    })
    expect(result.ok && result.body).toBe('# 正文\n内容')
  })

  it('折叠块标量（>）：单换行折叠为空格、空行保留为换行', () => {
    const result = parseSkillFile([
      '---',
      'description: >',
      '  第一行说明',
      '  第二行续写',
      '',
      '  空行后的段落',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.description).toBe('第一行说明 第二行续写\n空行后的段落\n')
  })

  it('字面块标量（|）：原样保留换行', () => {
    const result = parseSkillFile([
      '---',
      'description: |',
      '  第一行',
      '  第二行',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.description).toBe('第一行\n第二行\n')
  })

  it('块标量剥公共缩进（>-）且去尾换行', () => {
    const result = parseSkillFile([
      '---',
      'description: >-',
      '    深缩进',
      '    同级续行',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.description).toBe('深缩进 同级续行')
  })

  it('嵌套结构按块跳过不报错：metadata 下的缩进行不炸、值不消费', () => {
    const result = parseSkillFile([
      '---',
      'description: 说明',
      'metadata:',
      '  author: 某人',
      '  version: 1.2',
      '  nested:',
      '    deep: true',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.description).toBe('说明')
    expect(result.ok && result.frontmatter.metadata).toBe('')
    expect(result.ok && result.ignoredKeys).toEqual([])
  })

  it('引号值：双引号转义与单引号折叠', () => {
    const result = parseSkillFile([
      '---',
      'description: "带 \\"引号\\" 的说明"',
      'name: \'it\'\'s 名字\'',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.description).toBe('带 "引号" 的说明')
    expect(result.ok && result.frontmatter.name).toBe("it's 名字")
  })

  it('空值键：无后随缩进块时值为空、不误吞下一键', () => {
    const result = parseSkillFile([
      '---',
      'name:',
      'description: 说明',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.name).toBeUndefined()
    expect(result.ok && result.frontmatter.description).toBe('说明')
  })

  it('非白名单键计入 ignoredKeys，license 读取但不计入', () => {
    const result = parseSkillFile([
      '---',
      'description: 说明',
      'license: MIT',
      'allowed-tools: ["Bash"]',
      'hooks: post-commit',
      '---',
      '正文',
    ].join('\n'))

    expect(result.ok && result.frontmatter.license).toBe('MIT')
    expect(result.ok && [...result.ignoredKeys].sort()).toEqual(['allowed-tools', 'hooks'])
  })

  it('无 frontmatter：不报错，整文为正文', () => {
    const result = parseSkillFile('# 直接正文\n没有 frontmatter')

    expect(result).toMatchObject({
      ok: true,
      hasFrontmatter: false,
      frontmatter: {},
      ignoredKeys: [],
    })
    expect(result.ok && result.body).toBe('# 直接正文\n没有 frontmatter')
  })

  it('BOM 与 CRLF 归一后解析', () => {
    const result = parseSkillFile('---\r\nname: 甲\r\ndescription: 乙\r\n---\r\n正文\r\n')

    expect(result.ok && result.frontmatter.name).toBe('甲')
    expect(result.ok && result.frontmatter.description).toBe('乙')
    expect(result.ok && result.body).toBe('正文\n')
  })

  it('未闭合 frontmatter：ok=false（发现层转 skill_invalid_frontmatter）', () => {
    const result = parseSkillFile('---\nname: 甲\n无闭合分隔线')

    expect(result).toEqual({ ok: false, reason: 'unterminated-frontmatter' })
  })

  it('正文里的 --- 不被误认：闭合线是第一个整行 ---', () => {
    const result = parseSkillFile([
      '---',
      'description: 说明',
      '---',
      '',
      '---',
      '正文分隔线',
    ].join('\n'))

    expect(result.ok && result.body).toBe('---\n正文分隔线')
  })
})
