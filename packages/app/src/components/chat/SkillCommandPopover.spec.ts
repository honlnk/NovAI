// @vitest-environment happy-dom
/**
 * `#技能` 点名弹层组件测试（技能包 UI/UX 施工计划 阶段 3，§3.3）：筛选、
 * 空技能引导、无匹配提示、键盘导航（moveUp/moveDown/confirm）与点击选中。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { SkillView } from '@novai/core/services/types'
import SkillCommandPopover from './SkillCommandPopover.vue'

function skill(name: string, description: string): SkillView {
  return {
    name,
    description,
    directory: `skills/${name}`,
    skillFilePath: `skills/${name}/SKILL.md`,
    files: [],
    warnings: [],
  }
}

const SKILLS = [skill('去AI味', '消除机翻腔与套路句式'), skill('文风仿写', '模仿指定作者文风')]

/** defineExpose 方法经 vm 调用（类型收窄，父组件 keydown 导航走同一通道） */
type PopoverExposed = {
  moveUp: () => void
  moveDown: () => void
  confirm: () => void
}

function exposed(wrapper: ReturnType<typeof mountPopover>): PopoverExposed {
  return wrapper.vm as unknown as PopoverExposed
}

function mountPopover(skills: SkillView[], query = '') {
  return mount(SkillCommandPopover, { props: { skills, query } })
}

describe('SkillCommandPopover 列表与筛选', () => {
  it('列出全部技能；query 按名称与描述过滤', () => {
    const wrapper = mountPopover(SKILLS)
    expect(wrapper.find('[data-testid="skill-popover-item-去AI味"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="skill-popover-item-文风仿写"]').exists()).toBe(true)

    const filtered = mountPopover(SKILLS, '文风')
    expect(filtered.find('[data-testid="skill-popover-item-去AI味"]').exists()).toBe(false)
    expect(filtered.find('[data-testid="skill-popover-item-文风仿写"]').exists()).toBe(true)

    // 描述命中也保留（按描述找人名的场景）
    const byDesc = mountPopover(SKILLS, '机翻')
    expect(byDesc.find('[data-testid="skill-popover-item-去AI味"]').exists()).toBe(true)
  })

  it('无技能显示获取引导；有技能但无匹配显示无匹配提示', () => {
    const empty = mountPopover([])
    expect(empty.text()).toContain('还没有技能，可在左侧「技能」中新建或导入')

    const noMatch = mountPopover(SKILLS, '节奏')
    expect(noMatch.text()).toContain('没有匹配的技能')
  })

  it('点击技能行发出 select；点击项与 emit 名称为文件夹名', async () => {
    const wrapper = mountPopover(SKILLS)
    await wrapper.find('[data-testid="skill-popover-item-文风仿写"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['文风仿写']])
  })
})

describe('SkillCommandPopover 键盘导航（exposed）', () => {
  it('moveDown 高亮下移，confirm 选中当前高亮项', () => {
    const wrapper = mountPopover(SKILLS)
    const nav = exposed(wrapper)

    nav.confirm()
    expect(wrapper.emitted('select')).toEqual([['去AI味']])

    nav.moveDown()
    nav.confirm()
    expect(wrapper.emitted('select')).toEqual([['去AI味'], ['文风仿写']])

    // 循环：末项再下移回到首项
    nav.moveDown()
    nav.confirm()
    expect(wrapper.emitted('select')).toEqual([['去AI味'], ['文风仿写'], ['去AI味']])
  })

  it('moveUp 从首项循环到末项；无匹配时空操作不 emit', () => {
    const wrapper = mountPopover(SKILLS)
    const nav = exposed(wrapper)
    nav.moveUp()
    nav.confirm()
    expect(wrapper.emitted('select')).toEqual([['文风仿写']])

    const noMatch = mountPopover(SKILLS, '节奏')
    const noMatchNav = exposed(noMatch)
    noMatchNav.moveDown()
    noMatchNav.moveUp()
    noMatchNav.confirm()
    expect(noMatch.emitted('select')).toBeUndefined()
  })
})
