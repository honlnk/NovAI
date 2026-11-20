// @vitest-environment happy-dom
/**
 * 冲突处理布局（六个模块布局统一计划 阶段 1）：探测/缺失/不可读三态、内容比较
 * 插槽、副本表单（受控开合、默认名、空名禁用、busy）、四个出口与两击确认、
 * scopeKey 清理。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ConflictResolutionLayout from './ConflictResolutionLayout.vue'

function mountLayout(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(ConflictResolutionLayout, {
    props: { scopeKey: 's1', ...props },
    slots: { compare: '<p>比较内容</p>', header: '<p>说明</p>', ...slots },
  })
}

function button(wrapper: ReturnType<typeof mountLayout>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text)
}

describe('ConflictResolutionLayout：三态与比较区', () => {
  it('默认渲染说明区与比较区插槽', () => {
    const wrapper = mountLayout()
    expect(wrapper.text()).toContain('说明')
    expect(wrapper.text()).toContain('比较内容')
  })

  it('纵向滚动责任：本区整体可滚（消息区挤压时出口可达），比较区保底 min-h-32', () => {
    const wrapper = mountLayout()
    const root = wrapper.find('[data-testid="detail-conflict-resolution"]')
    expect(root.classes()).toContain('overflow-y-auto')
    expect(root.classes()).toContain('flex-1')
    const compare = wrapper.findAll('div').find((d) => d.classes().includes('min-h-32'))
    expect(compare).toBeDefined()
    expect(compare!.classes()).toContain('overflow-y-auto')
  })

  it('probing / missing / unreadable 分别占位，且不提供有损采用出口', () => {
    const probing = mountLayout({ probing: true })
    expect(probing.text()).toContain('正在检查另一版本')
    expect(button(probing, '采用磁盘版本')).toBeUndefined()

    const missing = mountLayout({ missing: true })
    expect(missing.text()).toContain('磁盘上已不存在')
    expect(button(missing, '采用磁盘版本')).toBeUndefined()

    const unreadable = mountLayout({ unreadable: 'boom' })
    expect(unreadable.text()).toContain('磁盘读取失败：boom')
    expect(button(unreadable, '采用我的内容')).toBeUndefined()
  })
})

describe('ConflictResolutionLayout：副本表单', () => {
  it('openCopy 事件上抛；copyOpen 打开后回填默认名，空名禁用提交', async () => {
    const wrapper = mountLayout()
    await button(wrapper, '另存为副本')!.trigger('click')
    expect(wrapper.emitted('openCopy')).toHaveLength(1)

    await wrapper.setProps({ copyOpen: true, defaultCopyName: '第一章（副本）' })
    const input = wrapper.find('[data-testid="detail-conflict-copy-form"] input')
    expect((input.element as HTMLInputElement).value).toBe('第一章（副本）')
    const submit = button(wrapper, '保存副本')!
    expect((submit.element as HTMLButtonElement).disabled).toBe(false)

    await input.setValue('')
    expect((button(wrapper, '保存副本')!.element as HTMLButtonElement).disabled).toBe(true)
    await input.setValue('副本名')
    await button(wrapper, '保存副本')!.trigger('click')
    expect(wrapper.emitted('submitCopy')).toEqual([['副本名']])
  })

  it('copyBusy 禁用提交并显示进行中文案；取消发出 closeCopy', async () => {
    const wrapper = mountLayout({ copyOpen: true, defaultCopyName: 'x', copyBusy: true, copyBusyLabel: '保存中…' })
    expect(button(wrapper, '保存中…')!.attributes('disabled')).toBeDefined()
    await button(wrapper, '取消')!.trigger('click')
    expect(wrapper.emitted('closeCopy')).toHaveLength(1)
  })

  it('copyError / copySavedNote 呈现在表单上方', () => {
    const wrapper = mountLayout({ copyError: '目标已存在', copySavedNote: '副本已保存：a.md' })
    expect(wrapper.find('[data-testid="detail-conflict-copy-error"]').text()).toBe('目标已存在')
    expect(wrapper.find('[data-testid="detail-conflict-copy-saved"]').text()).toBe('副本已保存：a.md')
  })
})

describe('ConflictResolutionLayout：四出口与两击确认', () => {
  it('返回发出 back 并清确认态；两种采用第一次只确认、第二次才发出', async () => {
    const wrapper = mountLayout()
    await button(wrapper, '采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toBeUndefined()
    expect(button(wrapper, '确认放弃我的修改，采用磁盘版本')).toBeDefined()

    await button(wrapper, '确认放弃我的修改，采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toHaveLength(1)

    await button(wrapper, '返回继续编辑')!.trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)

    await button(wrapper, '采用我的内容')!.trigger('click')
    expect(wrapper.emitted('adoptMine')).toBeUndefined()
    await button(wrapper, '确认覆盖磁盘，采用我的内容')!.trigger('click')
    expect(wrapper.emitted('adoptMine')).toHaveLength(1)
  })

  it('copyBusy 期间「采用我的内容」禁用（文件语义：整份覆盖等待副本结算）', async () => {
    const wrapper = mountLayout({ copyBusy: true })
    expect(button(wrapper, '采用我的内容')!.attributes('disabled')).toBeDefined()
    expect(button(wrapper, '采用磁盘版本')!.attributes('disabled')).toBeUndefined()
  })

  it('scopeKey 变化清理确认态（切对象/收起冲突）', async () => {
    const wrapper = mountLayout()
    await button(wrapper, '采用磁盘版本')!.trigger('click')
    await wrapper.setProps({ scopeKey: 's2' })
    // 确认态已清：按钮回到第一击文案
    expect(button(wrapper, '采用磁盘版本')).toBeDefined()
    await button(wrapper, '采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toBeUndefined()
  })
})
