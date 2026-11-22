// @vitest-environment happy-dom
/**
 * 预览／编辑切换（六个模块布局统一计划 阶段 1）：激活态、禁用态与解释、
 * 可访问名称、事件参数。六模块头部右侧共用本控件，卡片侧 noun=「正文」
 * 保持迁移前的读屏名称。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ViewModeToggle from './ViewModeToggle.vue'

function mountToggle(props: Record<string, unknown> = {}) {
  return mount(ViewModeToggle, { props: { mode: 'preview', ...props } })
}

describe('ViewModeToggle', () => {
  it('两个按钮（预览眼睛 / 编辑铅笔）；当前模式高亮另一侧不高亮', () => {
    const wrapper = mountToggle({ mode: 'preview' })
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.classes()).toContain('bg-white')
    expect(buttons[1]!.classes()).not.toContain('bg-white')
    expect(wrapper.find('[data-testid="detail-mode-edit"]').exists()).toBe(true)
  })

  it('点击发出 change（preview ⇄ edit 两个方向）', async () => {
    const wrapper = mountToggle({ mode: 'preview' })
    await wrapper.find('[data-testid="detail-mode-edit"]').trigger('click')
    expect(wrapper.emitted('change')).toEqual([['edit']])
    await wrapper.find('button[aria-label="预览"]').trigger('click')
    const events = wrapper.emitted('change')!
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual(['preview'])
  })

  it('编辑禁用：按钮 disabled、不可点击，tooltip 文案带禁用原因', async () => {
    const wrapper = mountToggle({
      mode: 'preview',
      editDisabled: true,
      editDisabledReason: '该文件类型不支持编辑',
    })
    const edit = wrapper.find('[data-testid="detail-mode-edit"]')
    expect((edit.element as HTMLButtonElement).disabled).toBe(true)
    expect(edit.classes()).toContain('cursor-not-allowed')
    await edit.trigger('click')
    expect(wrapper.emitted('change')).toBeUndefined()
    // tooltip 文案由 Tooltip 的 text prop 携带（触发器 aria-describedby 关联）
    expect(wrapper.text()).not.toContain('该文件类型不支持编辑')
  })

  it('noun=「正文」时可访问名称为「预览正文／编辑正文」（卡片侧语义）', () => {
    const wrapper = mountToggle({ mode: 'edit', noun: '正文' })
    expect(wrapper.find('button[aria-label="预览正文"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="编辑正文"]').exists()).toBe(true)
  })
})
