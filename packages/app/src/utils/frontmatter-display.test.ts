import { describe, expect, it } from 'vitest'

import { parseFrontmatterDisplay, splitFrontmatter } from './frontmatter-display'

/**
 * frontmatter 展示层切分与键值解析测试（文件预览卡片化计划 Step 1）。
 * 识别门槛：首行 --- + 闭合行 + 首条围栏内行呈键形态；解析刻意 dumb，展示容错。
 */
describe('splitFrontmatter 切分', () => {
  const SKILL = '---\nname: 去AI味\ndescription: 把 AI 生成的段落改回"人写的"质感\nwhen_to_use: 章节初稿完成后的润色\n---\n\n# 去 AI 味\n\n正文'

  it('标准围栏：raw 含分隔线、body 从正文开始', () => {
    const result = splitFrontmatter(SKILL)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.raw).toBe('---\nname: 去AI味\ndescription: 把 AI 生成的段落改回"人写的"质感\nwhen_to_use: 章节初稿完成后的润色\n---')
    expect(result.body).toBe('\n# 去 AI 味\n\n正文')
  })

  it('无 frontmatter：原文照返', () => {
    const result = splitFrontmatter('# 标题\n\n正文')
    expect(result.hasFrontmatter).toBe(false)
    expect(result.raw).toBe('')
    expect(result.body).toBe('# 标题\n\n正文')
  })

  it('未闭合围栏不识别', () => {
    const result = splitFrontmatter('---\nid: 陈砚\n只有正文没有闭合')
    expect(result.hasFrontmatter).toBe(false)
  })

  it('首条围栏内行非键形态不识别（场景分割线防护）', () => {
    const result = splitFrontmatter('---\n一场大雨冲掉了脚印。\n---\n\n后续正文')
    expect(result.hasFrontmatter).toBe(false)
  })

  it('空围栏不识别（首条内行为闭合线，非键形态）', () => {
    const result = splitFrontmatter('---\n---\n正文')
    expect(result.hasFrontmatter).toBe(false)
  })

  it('CRLF 与 BOM 归一后识别', () => {
    const result = splitFrontmatter('\uFEFF---\r\nid: 陈砚\r\n---\r\n\r\n正文')
    expect(result.hasFrontmatter).toBe(true)
    expect(result.body.startsWith('\n正文')).toBe(true)
  })

  it('扫描上限外不找闭合线（超长无闭合退化原文渲染）', () => {
    const filler = Array.from({ length: 300 }, (_, index) => `k${index}: v${index}`).join('\n')
    const result = splitFrontmatter(`---\n${filler}`)
    expect(result.hasFrontmatter).toBe(false)
  })
})

describe('parseFrontmatterDisplay 键值解析', () => {
  it('顶层键值：标量剥引号、数组切 chip、空值保留', () => {
    const fields = parseFrontmatterDisplay('---\nid: 陈砚\ntype: character\nname: "陈砚"\ntags: [主角, 穿越者, 工程思维, 雍州, 高陵]\nlastUpdatedChapter: ""\nupdatedAt:\n---')
    expect(fields).toEqual([
      { key: 'id', value: '陈砚' },
      { key: 'type', value: 'character' },
      { key: 'name', value: '陈砚' },
      { key: 'tags', value: ['主角', '穿越者', '工程思维', '雍州', '高陵'] },
      { key: 'lastUpdatedChapter', value: '' },
      { key: 'updatedAt', value: '' },
    ])
  })

  it('块标量 > 与 | 的续行收进同一值', () => {
    const fields = parseFrontmatterDisplay('---\ndescription: >\n  把 AI 生成的段落\n  改回人写的质感。\nwhen_to_use: |\n  章节初稿完成后的润色；\n  通读旧稿做统一清理。\n---')
    expect(fields).toEqual([
      { key: 'description', value: '把 AI 生成的段落\n改回人写的质感。' },
      { key: 'when_to_use', value: '章节初稿完成后的润色；\n通读旧稿做统一清理。' },
    ])
  })

  it('带折叠修饰的块标量（>-）同样收续行', () => {
    const fields = parseFrontmatterDisplay('---\ndescription: >-\n  第一行\n---')
    expect(fields).toEqual([{ key: 'description', value: '第一行' }])
  })

  it('值内 URL 冒号不裂键：首个冒号切分', () => {
    const fields = parseFrontmatterDisplay('---\nsee: http://example.com/docs?a=1\n---')
    expect(fields).toEqual([{ key: 'see', value: 'http://example.com/docs?a=1' }])
  })

  it('空围栏 / 仅分隔线返回空数组（卡片不渲染）', () => {
    expect(parseFrontmatterDisplay('---\n---')).toEqual([])
  })

  it('数组空列表与去空项', () => {
    expect(parseFrontmatterDisplay('---\nrelatedChapters: []\ntags: [ 主角 , , 穿越者 ]\n---')).toEqual([
      { key: 'relatedChapters', value: [] },
      { key: 'tags', value: ['主角', '穿越者'] },
    ])
  })
})
