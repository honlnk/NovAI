// @vitest-environment happy-dom
/**
 * frontmatter 属性卡片（文件预览卡片化计划 Step 2）：折叠条内容规则、
 * 展开/折叠切换、同路径展开态记忆、无 tags 回落摘要、空围栏不渲染。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import FrontmatterCard from './FrontmatterCard.vue'

const ELEMENT_RAW = '---\nid: 陈砚\ntype: character\nname: 陈砚\nsummary: 本书主角。现代程序员（加班猝死）魂穿成唐贞观七年的十七岁乞儿。\ntags: [主角, 穿越者, 工程思维, 雍州, 高陵]\nlastUpdatedChapter: ""\nrelatedChapters: []\nupdatedAt: ""\n---'
const SKILL_RAW = '---\nname: 去AI味\ndescription: 把 AI 生成的段落改回"人写的"质感——按病灶清单逐条清除套路句、解释癖、均匀节奏与万能意象，再用可核对的自查表验收。\nwhen_to_use: 章节初稿完成后的润色\n---'

function mountCard(props: { raw: string; path?: string }) {
  return mount(FrontmatterCard, { props })
}

describe('FrontmatterCard 折叠条', () => {
  it('标题取 name、tags 切 chip、字段数正确；默认折叠无网格', () => {
    const wrapper = mountCard({ raw: ELEMENT_RAW })
    const bar = wrapper.find('[data-testid="frontmatter-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-expanded')).toBe('false')
    expect(bar.text()).toContain('陈砚')
    const chips = bar.findAll('span').filter((node) => node.classes().includes('rounded-full'))
    expect(chips.map((node) => node.text())).toEqual(['主角', '穿越者', '工程思维', '雍州', '高陵'])
    expect(bar.text()).toContain('8 个字段')
    expect(wrapper.find('[data-testid="frontmatter-grid"]').exists()).toBe(false)
  })

  it('无 tags 回落为摘要截断 42 字（技能文件形态）', () => {
    const description = '把 AI 生成的段落改回"人写的"质感——按病灶清单逐条清除套路句、解释癖、均匀节奏与万能意象，再用可核对的自查表验收。'
    const wrapper = mountCard({ raw: SKILL_RAW })
    const bar = wrapper.find('[data-testid="frontmatter-bar"]')
    expect(bar.text()).toContain('去AI味')
    expect(bar.text()).toContain(`${description.slice(0, 42)}…`)
    expect(bar.text()).not.toContain('验收')
    expect(bar.text()).toContain('3 个字段')
  })

  it('点击展开网格：键值行齐全、空值以 — 占位、aria-expanded 翻转', async () => {
    const wrapper = mountCard({ raw: ELEMENT_RAW })
    await wrapper.find('[data-testid="frontmatter-bar"]').trigger('click')
    const grid = wrapper.find('[data-testid="frontmatter-grid"]')
    expect(grid.exists()).toBe(true)
    expect(wrapper.find('[data-testid="frontmatter-bar"]').attributes('aria-expanded')).toBe('true')
    const rows = grid.findAll('.grid')
    expect(rows).toHaveLength(8)
    expect(rows[0]!.text()).toContain('陈砚')
    // lastUpdatedChapter: "" 空值 → —
    expect(rows[5]!.text()).toContain('—')
    // relatedChapters: [] 空数组 → —
    expect(rows[6]!.text()).toContain('—')
    // 再点一次收回
    await wrapper.find('[data-testid="frontmatter-bar"]').trigger('click')
    expect(wrapper.find('[data-testid="frontmatter-grid"]').exists()).toBe(false)
  })

  it('同路径展开态记忆：切走再切回保持展开，其他路径互不影响', async () => {
    const first = mountCard({ raw: ELEMENT_RAW, path: 'elements/characters/陈砚.md' })
    await first.find('[data-testid="frontmatter-bar"]').trigger('click')
    first.unmount()

    const again = mountCard({ raw: ELEMENT_RAW, path: 'elements/characters/陈砚.md' })
    expect(again.find('[data-testid="frontmatter-grid"]').exists()).toBe(true)

    const other = mountCard({ raw: SKILL_RAW, path: 'skills/去AI味/SKILL.md' })
    expect(other.find('[data-testid="frontmatter-grid"]').exists()).toBe(false)
  })

  it('空围栏（0 个字段）不渲染任何节点', () => {
    const wrapper = mountCard({ raw: '---\n---' })
    expect(wrapper.find('[data-testid="frontmatter-card"]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
