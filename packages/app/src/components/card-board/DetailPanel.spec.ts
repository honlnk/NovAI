// @vitest-environment happy-dom
/**
 * 卡片详情骨架的业务接线基线（六个模块布局统一计划 阶段 0）：
 * 在旧实现上先证明标题、模式切换、状态按钮、保存状态、冲突出口与守护出口
 * 确实接到正确事件——后续阶段 3 将删除本骨架，测试断言只认业务事件与数据，
 * 不把「状态灯在底部」等即将被替换的布局位置固化成规范（迁移后由统一布局的
 * 结构测试接管位置断言）。
 *
 * 运行方式：pnpm --filter @novai/app exec vitest run src/components/card-board
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

import DetailPanel from './DetailPanel.vue'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'

type ConflictProp = { probing: boolean; missing: boolean; unreadable?: string; expanded: boolean }

const COLUMNS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'in-progress', label: '进行中' },
  { key: 'done', label: '已完成' },
]

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(DetailPanel, {
    props: {
      cardId: 'card-1',
      titleValue: '第一章',
      titlePlaceholder: '计划名',
      columns: COLUMNS,
      activeColumnKey: 'inbox',
      pendingColumnKey: null,
      detailMode: 'preview',
      savePhase: 'clean',
      conflict: null,
      conflictFields: [],
      guard: null,
      actionError: '',
      updatedAt: '2026-11-20T10:00:00Z',
      testidPrefix: 'plan',
      ...overrides,
    },
  })
}

function findButtonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((button) => button.text() === text)
}

/** 展开比较所需的两个长正文字段：中段未改动（产生可折叠区），两端各一处修改 */
function longFields(): CardConflictField[] {
  const middle = Array.from({ length: 12 }, (_, i) => `第${i + 1}段未改动内容`)
  const mk = (key: string, label: string, mineHead: string, diskHead: string): CardConflictField => ({
    key,
    label,
    kind: 'long',
    mine: [mineHead, ...middle, '结尾段我的'].join('\n'),
    disk: [diskHead, ...middle, '结尾段我的'].join('\n'),
  })
  return [
    mk('body-a', '正文 A', '开头我的版本', '开头磁盘版本'),
    mk('body-b', '正文 B', '开头我的版本', '开头磁盘版本'),
  ]
}

describe('卡片详情骨架：标题与模式切换接线', () => {
  it('标题输入发出 updateTitle；守护期间只读', async () => {
    const wrapper = mountPanel({ guard: { kind: 'deleted', trashPath: 'trash/x.md' } as CardSessionGuard })
    const title = wrapper.find('[data-testid="plan-detail-title"]')
    expect(title.attributes('readonly')).toBeDefined()

    await wrapper.setProps({ guard: null })
    expect(title.attributes('readonly')).toBeUndefined()
    await title.setValue('新标题')
    expect(wrapper.emitted('updateTitle')).toEqual([['新标题']])
  })

  it('预览/编辑分段控件发出 setDetailMode（两个方向）', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="plan-detail-edit"]').trigger('click')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])
    await wrapper.find('button[aria-label="预览正文"]').trigger('click')
    const events = wrapper.emitted('setDetailMode')!
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual(['preview'])
  })
})

describe('卡片详情骨架：状态按钮与保存状态接线', () => {
  it('状态按钮点击发出 selectStatus（列 key 原样上抛）', async () => {
    const wrapper = mountPanel()
    await findButtonByText(wrapper, '进行中')!.trigger('click')
    expect(wrapper.emitted('selectStatus')).toEqual([['in-progress']])
  })

  it('五种保存阶段的文案与失败重试出口', async () => {
    const wrapper = mountPanel({ savePhase: 'pending' })
    expect(wrapper.find('[data-testid="plan-detail-save-status"]').text()).toContain('等待保存')

    await wrapper.setProps({ savePhase: 'saving' })
    expect(wrapper.find('[data-testid="plan-detail-save-status"]').text()).toContain('正在保存')

    await wrapper.setProps({ savePhase: 'conflict' })
    expect(wrapper.find('[data-testid="plan-detail-save-status"]').text()).toContain('保存冲突')

    await wrapper.setProps({ savePhase: 'failed' })
    const status = wrapper.find('[data-testid="plan-detail-save-status"]')
    expect(status.text()).toContain('保存失败')
    await wrapper.find('[data-testid="plan-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retrySave')).toHaveLength(1)

    await wrapper.setProps({ savePhase: 'clean' })
    expect(wrapper.find('[data-testid="plan-detail-save-status"]').text()).toContain('已保存')
  })

  it('待保存状态列显示等待标记，已生效列不重复标记', () => {
    const wrapper = mountPanel({ pendingColumnKey: 'done', activeColumnKey: 'inbox' })
    const done = findButtonByText(wrapper, '已完成')!
    expect(done.text()).toContain('已完成')
    // 等待标记是列按钮内的圆点 span；已生效列（inbox）无标记
    expect(findButtonByText(wrapper, '收件箱')!.find('span.animate-pulse').exists()).toBe(false)
    expect(done.find('span.animate-pulse').exists()).toBe(true)
  })
})

describe('卡片详情骨架：冲突紧凑条与展开比较接线', () => {
  const compactConflict: ConflictProp = { probing: false, missing: false, expanded: false }

  it('紧凑条「比较并处理」发出 expandConflict', async () => {
    const wrapper = mountPanel({ conflict: compactConflict })
    await wrapper.find('[data-testid="plan-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expandConflict')).toHaveLength(1)
  })

  it('展开比较时「返回继续编辑」发出 collapseConflict，常规工具区与底部收起', async () => {
    const wrapper = mountPanel({ conflict: { ...compactConflict, expanded: true } })
    expect(findButtonByText(wrapper, '收件箱')).toBeUndefined()
    expect(wrapper.find('[data-testid="plan-detail-save-status"]').exists()).toBe(false)

    await findButtonByText(wrapper, '返回继续编辑')!.trigger('click')
    expect(wrapper.emitted('collapseConflict')).toHaveLength(1)
  })

  it('两种有损采用第一次只进入确认，第二次才发出事件；确认文案随状态切换', async () => {
    const wrapper = mountPanel({ conflict: { ...compactConflict, expanded: true } })
    const disk = findButtonByText(wrapper, '采用磁盘版本')!
    await disk.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toBeUndefined()
    expect(findButtonByText(wrapper, '确认放弃我的修改，采用磁盘版本')).toBeDefined()

    await findButtonByText(wrapper, '确认放弃我的修改，采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toHaveLength(1)
    // 确认态复位：再次点击重新走两击
    await findButtonByText(wrapper, '采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toHaveLength(1)

    const mine = findButtonByText(wrapper, '采用我的内容')!
    await mine.trigger('click')
    expect(wrapper.emitted('adoptMine')).toBeUndefined()
    await findButtonByText(wrapper, '确认覆盖磁盘，采用我的内容')!.trigger('click')
    expect(wrapper.emitted('adoptMine')).toHaveLength(1)
  })

  it('磁盘不可读（missing/unreadable/probing）时不提供有损采用出口', () => {
    for (const conflict of [
      { ...compactConflict, expanded: true, missing: true },
      { ...compactConflict, expanded: true, unreadable: 'boom' },
      { ...compactConflict, expanded: true, probing: true },
    ] as ConflictProp[]) {
      const wrapper = mountPanel({ conflict, conflictFields: longFields() })
      expect(findButtonByText(wrapper, '采用磁盘版本')).toBeUndefined()
      expect(findButtonByText(wrapper, '采用我的内容')).toBeUndefined()
    }
  })

  it('另存副本表单：默认名带「（副本）」可提交，清空后禁用，提交发出 saveCopy', async () => {
    const wrapper = mountPanel({ conflict: { ...compactConflict, expanded: true } })
    await findButtonByText(wrapper, '将我的内容另存为新卡片')!.trigger('click')

    const input = wrapper.find('input[placeholder="新卡片名称"]')
    expect((input.element as HTMLInputElement).value).toBe('第一章（副本）')

    // 默认名非空即可提交；本地输入清空后禁用（表单态由骨架持有）
    const submit = findButtonByText(wrapper, '保存为新卡片')!
    expect((submit.element as HTMLButtonElement).disabled).toBe(false)
    await input.setValue('')
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
    await input.setValue('新卡名')
    await submit.trigger('click')
    expect(wrapper.emitted('saveCopy')).toEqual([['新卡名']])
  })

  it('长字段差异折叠隔离：A 字段展开不影响同折叠号的 B 字段', async () => {
    const wrapper = mountPanel({
      conflict: { ...compactConflict, expanded: true },
      conflictFields: longFields(),
    })
    const foldButtons = wrapper.findAll('button').filter((b) => b.text().includes('展开'))
    expect(foldButtons.length).toBe(2)

    await foldButtons[0]!.trigger('click')
    await nextTick()
    // A 字段出现「收起」，B 字段保持「展开」
    const after = wrapper.findAll('button').filter((b) => b.text().includes('收起'))
    expect(after.length).toBe(1)
  })

  it('切换卡片清理两击确认与副本表单残留', async () => {
    const wrapper = mountPanel({ conflict: { ...compactConflict, expanded: true } })
    await findButtonByText(wrapper, '采用磁盘版本')!.trigger('click')
    await findButtonByText(wrapper, '将我的内容另存为新卡片')!.trigger('click')

    await wrapper.setProps({ cardId: 'card-2' })
    expect(findButtonByText(wrapper, '采用磁盘版本')).toBeDefined()
    expect(findButtonByText(wrapper, '将我的内容另存为新卡片')).toBeDefined()
    // 新卡片上第一次点击仍只是确认（残留确认态已被清掉）
    await findButtonByText(wrapper, '采用磁盘版本')!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toBeUndefined()
  })
})

describe('卡片详情骨架：守护出口接线', () => {
  it('删除守护：恢复表单提交发出 restoreAsCopy，「放弃并关闭」发出 discardGuard', async () => {
    const wrapper = mountPanel({ guard: { kind: 'deleted', trashPath: 'trash/a.md' } as CardSessionGuard })
    await findButtonByText(wrapper, '恢复为新卡片')!.trigger('click')

    const input = wrapper.find('input[placeholder="新卡片名称"]')
    expect((input.element as HTMLInputElement).value).toBe('第一章（副本）')
    await input.setValue('守护副本')
    await findButtonByText(wrapper, '保存为新卡片')!.trigger('click')
    expect(wrapper.emitted('restoreAsCopy')).toEqual([['守护副本']])

    await findButtonByText(wrapper, '放弃并关闭')!.trigger('click')
    expect(wrapper.emitted('discardGuard')).toHaveLength(1)
  })

  it('重命名守护：展示新位置并发出 discardGuard', async () => {
    const wrapper = mountPanel({ guard: { kind: 'renamed', toPath: 'plans/new.md' } as CardSessionGuard })
    expect(wrapper.text()).toContain('plans/new.md')
    await findButtonByText(wrapper, '放弃并关闭')!.trigger('click')
    expect(wrapper.emitted('discardGuard')).toHaveLength(1)
  })
})
