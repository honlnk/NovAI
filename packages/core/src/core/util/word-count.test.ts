import { describe, expect, it } from 'vitest'

import {
  CHAPTER_TITLE_LINE_PATTERN,
  countContentChars,
  countMarkdownChars,
  countPlainTextChars,
  stripMarkdownToText,
} from './word-count'

describe('countPlainTextChars 纯文本字数（§6）', () => {
  it('统计非空白字符，含标点，空白不计', () => {
    expect(countPlainTextChars('贞观七年，三月末。\n\n柳絮正飞。')).toBe(14)
  })

  it('空文件为 0', () => {
    expect(countPlainTextChars('')).toBe(0)
    expect(countPlainTextChars('  \n\t ')).toBe(0)
  })

  it('章节标题行：首行符合「第+编号+章+空白+标题」约定时排除', () => {
    const chapter = '第001章 东宫听讼\n\n贞观七年，三月末。'
    expect(countPlainTextChars(chapter, { chapterTitle: true })).toBe(9)
  })

  it('首行不是标题约定则全量统计（chapterTitle 选项不影响）', () => {
    expect(countPlainTextChars('贞观七年，三月末。', { chapterTitle: true })).toBe(9)
  })

  it('单行文件恰为标题时统计为 0', () => {
    expect(countPlainTextChars('第001章 东宫听讼', { chapterTitle: true })).toBe(0)
  })

  it('CHAPTER_TITLE_LINE_PATTERN：编号与标题间必须有空白，正文行不误伤', () => {
    expect(CHAPTER_TITLE_LINE_PATTERN.test('第001章 东宫听讼')).toBe(true)
    expect(CHAPTER_TITLE_LINE_PATTERN.test('第12章 谏臣风骨')).toBe(true)
    expect(CHAPTER_TITLE_LINE_PATTERN.test('第001章东宫听讼')).toBe(false)
    expect(CHAPTER_TITLE_LINE_PATTERN.test('李承乾说：第001章 听讼')).toBe(false)
  })
})

describe('stripMarkdownToText 剥离（§6 Markdown 口径）', () => {
  it('排除标记、保留文字', () => {
    expect(stripMarkdownToText('# 标题\n\n**加粗** 与 *斜体* 文字')).toBe('标题\n\n加粗 与 斜体 文字')
  })

  it('链接保留文字丢弃地址，图片保留替代文本', () => {
    expect(stripMarkdownToText('[东宫](https://example.com/a) 见 ![图](https://e.com/b.png)')).toBe(
      '东宫 见 图',
    )
  })

  it('frontmatter 元信息头整体排除', () => {
    const md = '---\nname: 东宫\ntype: location\n---\n\n太子居所。'
    expect(stripMarkdownToText(md)).toBe('\n太子居所。')
    expect(countMarkdownChars(md)).toBe(5)
  })

  it('代码块：语言标记排除，代码内容计入', () => {
    const md = '前文\n\n```ts\nconst a = 1\n```\n\n后文'
    expect(stripMarkdownToText(md)).toContain('const a = 1')
    expect(stripMarkdownToText(md)).not.toContain('```ts')
    expect(countMarkdownChars(md)).toBe('前文'.length + 'consta=1'.length + '后文'.length)
  })

  it('列表与引用标记排除、文字保留；表格分隔行不计', () => {
    const md = '- 甲\n- 乙\n\n> 引用句\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    const stripped = stripMarkdownToText(md)
    expect(stripped).toContain('甲')
    expect(stripped).toContain('引用句')
    expect(countMarkdownChars(md)).toBe('甲乙引用句ab12'.length)
  })

  it('行内代码保留内容去反引号', () => {
    expect(countMarkdownChars('用 `novai` 命名')).toBe('用novai命名'.length)
  })
})

describe('countContentChars 分发（§6）', () => {
  it('markdown 格式走剥离统计', () => {
    expect(countContentChars('**你好**世界', 'markdown')).toBe(4)
  })

  it('text 格式章节排除标题行', () => {
    expect(countContentChars('第001章 东宫听讼\n\n正文九个字。', 'text', { isChapter: true })).toBe(6)
  })

  it('text 格式非章节文件全量统计', () => {
    expect(countContentChars('第001章 东宫听讼', 'text')).toBe(9)
  })

  it('json 格式不统计（稿件口径外）', () => {
    expect(countContentChars('{"a":1}', 'json')).toBe(0)
  })
})
