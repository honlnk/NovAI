import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'
import { parseMarkdownBlocks } from './markdown-blocks'

/**
 * 块级渲染（parseMarkdownBlocks）测试：切块边界、key 稳定性、与整篇渲染的等价性。
 * node 环境可跑——markdown-it 不依赖 DOM，DOM 复用行为由 Vue 侧承担（手动验收）。
 */
describe('parseMarkdownBlocks 切块', () => {
  it('混合文档按顶层块切开：标题 / 段落 / 列表 / 代码块各自成组', () => {
    const source = '# 标题\n\n第一段\n\n- 甲\n- 乙\n\n```js\nconst x = 1\n```\n\n结尾段'
    const blocks = parseMarkdownBlocks(source)
    expect(blocks).toHaveLength(5)
    expect(blocks[0].html).toContain('<h1>')
    expect(blocks[1].html).toContain('<p>')
    expect(blocks[2].html).toContain('<ul>')
    expect(blocks[3].html).toContain('<pre>')
    expect(blocks[4].html).toContain('结尾段')
    // key 按块起始行严格递增
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index].key).toBeGreaterThan(blocks[index - 1].key)
    }
  })

  it('嵌套结构不切碎：blockquote 内多层内容同组', () => {
    const source = '> 引用一段\n>\n> - 列表甲\n> - 列表乙\n\n外部段'
    const blocks = parseMarkdownBlocks(source)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].html).toContain('<blockquote>')
    expect(blocks[0].html).toContain('<li>列表乙</li>')
    expect(blocks[1].html).toContain('外部段')
  })

  it('未闭合 fence 归尾块（流式中间态不炸）', () => {
    const blocks = parseMarkdownBlocks('先说结论\n\n```ts\nconst x = 1')
    expect(blocks).toHaveLength(2)
    expect(blocks[1].html).toContain('const x = 1')
  })

  it('空文本 / 纯空白返回空块数组', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(parseMarkdownBlocks('\n\n')).toEqual([])
  })

  it('key 稳定：文末追加新块不影响前缀块的 key', () => {
    const before = parseMarkdownBlocks('第一段\n\n第二段')
    const after = parseMarkdownBlocks('第一段\n\n第二段\n\n第三段')
    expect(after).toHaveLength(3)
    expect(after[0].key).toBe(before[0].key)
    expect(after[1].key).toBe(before[1].key)
    expect(after[0].html).toBe(before[0].html)
    expect(after[1].html).toBe(before[1].html)
  })

  it('setext 升级保持首块 key：段落变标题时 key 不变（Vue 更新而非重挂）', () => {
    const before = parseMarkdownBlocks('标题')
    const after = parseMarkdownBlocks('标题\n===')
    expect(after[0].key).toBe(before[0].key)
    expect(after[0].html).toContain('<h1>')
  })

  it('与整篇渲染等价：块拼接 HTML 与 renderMarkdown 一致（含 reference link / linkify / typographer）', () => {
    const samples = [
      '# 标题\n\n第一段 **加粗** 与 *斜体*。\n\n第二段 `code` 收尾。',
      '- 列表甲\n- 列表乙\n  - 嵌套丙\n\n1. 有序一\n2. 有序二',
      '> 引用\n> 多行\n\n| 表头 | 列 |\n| --- | --- |\n| 甲 | 乙 |',
      '[参考链接][ref] 与裸链 https://example.com。\n\n[ref]: https://example.com/docs',
      '```js\nconst a = 1\n```\n\n---\n\n分隔后段落',
      '智能引号 "引号" 与省略号...\n\n破折号 --- 测试',
    ]
    for (const source of samples) {
      const joined = parseMarkdownBlocks(source).map((block) => block.html).join('')
      expect(joined).toBe(renderMarkdown(source))
    }
  })

  it('流式增长场景：逐行追加时前缀块 html 逐帧冻结', () => {
    const frames = [
      '# 草稿',
      '# 草稿\n\n第一段。',
      '# 草稿\n\n第一段。\n\n- 要点一',
      '# 草稿\n\n第一段。\n\n- 要点一\n- 要点二',
      '# 草稿\n\n第一段。\n\n- 要点一\n- 要点二\n\n收尾段。',
    ]
    let previous = parseMarkdownBlocks(frames[0])
    for (const frame of frames.slice(1)) {
      const next = parseMarkdownBlocks(frame)
      // 前缀块（除最后一个外）的 key+html 与上一帧逐帧一致
      for (let index = 0; index < previous.length - 1; index += 1) {
        expect(next[index].key).toBe(previous[index].key)
        expect(next[index].html).toBe(previous[index].html)
      }
      previous = next
    }
  })
})
