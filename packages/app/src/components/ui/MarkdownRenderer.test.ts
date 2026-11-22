// @vitest-environment happy-dom
/**
 * MarkdownRenderer frontmatter 透传回归（文件预览卡片化计划 Step 3 真机回归增补）：
 * path prop 必须透传给 FrontmatterCard 作展开态记忆键——缺省时同一实例切换文件
 * （frontmatter 块 key 恒为 0，组件被复用）会把展开态泄漏到下一个文件。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import MarkdownRenderer from './MarkdownRenderer.vue'

const SKILL_PATH = 'skills/透传回归/SKILL.md'
const ELEMENT_PATH = 'elements/characters/透传回归.md'
// 模块级展开态记忆跨用例共享，复用切换用例用独立路径避免继承上一用例的状态
const SKILL_PATH_B = 'skills/透传回归B/SKILL.md'
const ELEMENT_PATH_B = 'elements/characters/透传回归B.md'
const SKILL_SOURCE =
  '---\nname: 去AI味\ndescription: 把 AI 生成的段落改回"人写的"质感。\n---\n\n# 去 AI 味\n\n正文。'
const ELEMENT_SOURCE =
  '---\nname: 李世民\ntype: character\ntags: [皇帝]\n---\n\n# 李世民\n\n正文。'

describe('MarkdownRenderer frontmatter 透传', () => {
  it('frontmatter 开启时渲染卡片，path 透传为展开态记忆键', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: SKILL_SOURCE, frontmatter: true, path: SKILL_PATH },
    })
    const bar = wrapper.find('[data-testid="frontmatter-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-expanded')).toBe('false')
    await bar.trigger('click')
    expect(wrapper.find('[data-testid="frontmatter-bar"]').attributes('aria-expanded')).toBe(
      'true',
    )
    wrapper.unmount()

    // 卸载后同路径重挂：记忆生效保持展开
    const again = mount(MarkdownRenderer, {
      props: { content: SKILL_SOURCE, frontmatter: true, path: SKILL_PATH },
    })
    expect(again.find('[data-testid="frontmatter-bar"]').attributes('aria-expanded')).toBe('true')
    again.unmount()
  })

  it('实例复用切换文件（content+path 同变）：展开态不泄漏、切回恢复', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: SKILL_SOURCE, frontmatter: true, path: SKILL_PATH_B },
    })
    await wrapper.find('[data-testid="frontmatter-bar"]').trigger('click')
    expect(wrapper.find('[data-testid="frontmatter-bar"]').attributes('aria-expanded')).toBe(
      'true',
    )

    // 模拟 FilePanelBody 复用实例切到另一文件（两个文件的 frontmatter 块 key 同为 0）
    await wrapper.setProps({ content: ELEMENT_SOURCE, path: ELEMENT_PATH_B })
    const newBar = wrapper.find('[data-testid="frontmatter-bar"]')
    expect(newBar.text()).toContain('李世民')
    expect(newBar.attributes('aria-expanded')).toBe('false')

    // 切回原文件：按路径记忆恢复展开
    await wrapper.setProps({ content: SKILL_SOURCE, path: SKILL_PATH })
    expect(wrapper.find('[data-testid="frontmatter-bar"]').attributes('aria-expanded')).toBe(
      'true',
    )
    wrapper.unmount()
  })

  it('frontmatter 缺省（聊天路径）不识别围栏，无卡片', () => {
    const wrapper = mount(MarkdownRenderer, { props: { content: SKILL_SOURCE } })
    expect(wrapper.find('[data-testid="frontmatter-card"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
