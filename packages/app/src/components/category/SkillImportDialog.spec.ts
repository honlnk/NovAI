// @vitest-environment happy-dom
/**
 * 技能合集导入对话框组件测试（技能包 UI/UX 施工计划 阶段 2 门禁，决策 12）：
 * 勾选与全选、同名已存在不可勾、结果态逐个可见、导入失败可重试。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillImportCandidateView, SkillImportOutcomeView } from '@novai/core/services/types'
import SkillImportDialog from './SkillImportDialog.vue'

/** defineExpose 方法经 vm 调用（类型收窄；complete/fail 是父组件回报通道） */
type DialogExposed = {
  complete: (outcome: SkillImportOutcomeView) => void
  fail: (error: unknown) => void
}

function exposed(wrapper: ReturnType<typeof mountDialog>): DialogExposed {
  return wrapper.vm as unknown as DialogExposed
}

function candidates(): SkillImportCandidateView[] {
  return [
    { folderName: '去AI味', hasConflict: true },
    { folderName: '文风仿写', hasConflict: false },
    { folderName: '节奏控制', hasConflict: false },
  ]
}

function mountDialog() {
  return mount(SkillImportDialog, {
    props: { sourceName: '外部技能集', candidates: candidates() },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SkillImportDialog 勾选', () => {
  it('同名已存在不可勾选；可选项默认全选', () => {
    const wrapper = mountDialog()

    expect(wrapper.find('[data-testid="skill-import-check-去AI味"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="skill-import-conflict"]').text()).toBe('同名已存在')
    expect(wrapper.find('[data-testid="skill-import-check-文风仿写"]').exists()).toBe(true)

    // 默认全选可选项（导入整套合集是主路径）
    expect(wrapper.find('[data-testid="skill-import-confirm"]').text()).toContain('2')
  })

  it('取消全选后确认禁用；重新勾选后确认发出所选列表', async () => {
    const wrapper = mountDialog()

    await wrapper.find('[data-testid="skill-import-toggle-all"]').trigger('click')
    expect(wrapper.find('[data-testid="skill-import-confirm"]').attributes('disabled')).toBeDefined()

    await wrapper.find('[data-testid="skill-import-check-文风仿写"]').setValue(true)
    await wrapper.find('[data-testid="skill-import-confirm"]').trigger('click')

    expect(wrapper.emitted('confirm')).toEqual([[['文风仿写']]])
  })
})

describe('SkillImportDialog 结果态（决策 12「导入结果逐个可见」）', () => {
  it('complete 后逐项显示已导入/已跳过，底部汇总，完成关闭', async () => {
    const wrapper = mountDialog()

    await wrapper.find('[data-testid="skill-import-confirm"]').trigger('click')
    exposed(wrapper).complete({ imported: ['文风仿写'], skipped: [{ folderName: '节奏控制', reason: 'exists' }] })
    await nextTickStable()

    expect(wrapper.find('[data-testid="skill-import-done"]').text()).toBe('已导入')
    expect(wrapper.find('[data-testid="skill-import-skipped"]').text()).toBe('已跳过')
    expect(wrapper.text()).toContain('已导入 1 个')
    expect(wrapper.text()).toContain('跳过 1 个同名')

    await wrapper.find('[data-testid="skill-import-finish"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('fail 后错误显示在框内，可重新确认', async () => {
    const wrapper = mountDialog()

    await wrapper.find('[data-testid="skill-import-toggle-all"]').trigger('click')
    await wrapper.find('[data-testid="skill-import-check-节奏控制"]').setValue(true)
    await wrapper.find('[data-testid="skill-import-confirm"]').trigger('click')
    exposed(wrapper).fail(new Error('源文件夹读取失败'))
    await nextTickStable()

    expect(wrapper.find('[data-testid="skill-import-error"]').text()).toContain('读取失败')

    await wrapper.find('[data-testid="skill-import-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(2)
  })
})

/** complete/fail 直接改内部状态后等两拍（watcher 与渲染都落定） */
async function nextTickStable() {
  await vi.waitFor(() => undefined)
}
