import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'

/**
 * 链接渲染测试：聊天正文链接新标签打开（SPA 内当前页跳转会顶掉应用）。
 */
describe('markdown 链接新标签打开', () => {
  it('markdown 链接带 target=_blank 与 noopener noreferrer', () => {
    const html = renderMarkdown('[来源](https://example.com/a)')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('linkify 自动识别的裸 URL 同样生效', () => {
    const html = renderMarkdown('详见 https://zh.wikipedia.org/wiki/岳飞')
    expect(html).toContain('href="https://zh.wikipedia.org/wiki/')
    expect(html).toContain('target="_blank"')
  })

  it('重复渲染不叠加属性（token 每次重建，attrPush 只落一次）', () => {
    const source = '[链接](https://example.com)'
    const first = renderMarkdown(source)
    const second = renderMarkdown(source)
    expect(second).toBe(first)
    expect(second.match(/target=/g)).toHaveLength(1)
  })
})
