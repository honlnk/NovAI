import { describe, expect, it } from 'vitest'

import { DEFAULT_ELEMENT_SCHEMA } from './defaults'

/**
 * 要素库规范默认内容（prompts/ELEMENT.md）的六节齐全性校验。
 * 内容细目由《要素园丁子代理设计》§7.3 定稿；这里只锁「六节标题 + 关键铁律」，
 * 不锁全文逐字——规范允许后续微调文案，结构漂移才该挂测试。
 */
describe('DEFAULT_ELEMENT_SCHEMA', () => {
  const sections = [
    '## 六类目录职责与边界',
    '## 命名规范',
    '## frontmatter 维护规范',
    '## 链接约定',
    '## 园丁工作守则',
    '## 模板结构说明',
  ]

  it.each(sections)('包含定稿小节：%s', (section) => {
    expect(DEFAULT_ELEMENT_SCHEMA).toContain(section)
  })

  it('entities 与 worldbuilding 的判断原则已写明（设计 §7.3 第 1 节核心）', () => {
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('entities 与 worldbuilding 的分界')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('会被具体持有、点名、损耗、转移的东西归 entities')
  })

  it('frontmatter 维护三铁律：tags 去重、relatedChapters 取并集、lastUpdatedChapter 取最新', () => {
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('tags：去除重复')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('relatedChapters：与已有列表取并集')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('lastUpdatedChapter：取涉及章节中最新的一章')
  })

  it('链接约定按决策 5：素材→章节写路径、素材↔素材双方括号、正文不写链接', () => {
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('[[云溪]]')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('章节正文内不写任何链接')
  })

  it('园丁守则含不可让渡边界：不删文件、不动 chapters/ 与 prompts/、存疑不合并', () => {
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('不删除任何文件')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('从不修改 chapters/ 正文')
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('存疑不合并')
  })

  it('模板结构说明与 core templates.ts 五类分节名一致', async () => {
    const { ELEMENT_BODY_TEMPLATES } = await import('../elements/templates')
    for (const [type, template] of Object.entries(ELEMENT_BODY_TEMPLATES)) {
      // 每类模板的首个小节名必须出现在规范里（代表性锚点，不逐节锁）
      const firstSection = template.match(/^## (.+)$/m)?.[1]
      expect(firstSection, `要素类型 ${type} 的首个模板小节应写进规范`).toBeTruthy()
      expect(DEFAULT_ELEMENT_SCHEMA).toContain(firstSection!)
    }
    expect(DEFAULT_ELEMENT_SCHEMA).toContain('worldbuilding（世界观）：无固定模板')
  })
})
