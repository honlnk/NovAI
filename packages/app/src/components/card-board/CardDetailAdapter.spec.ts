// @vitest-environment happy-dom
/**
 * 卡片展示适配器组成件（六个模块布局统一计划 阶段 1/3）：状态工具（列按钮、
 * 待保存标记、空列不占位）、冲突紧凑条、字段比较（短字段并排/长字段差异块/
 * 一致统计）、守护横幅卡片版（恢复表单/放弃出口/守护变化清理）、保存失败条
 * （重试归消息区）与冲突处理装配（卡片文案/副本文案/四出口/切卡清理）。
 * 三类卡片领域详情共用本组组件，不再各自复制。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import CardStatusTools from './CardStatusTools.vue'
import CardConflictBar from './CardConflictBar.vue'
import CardConflictCompare from './CardConflictCompare.vue'
import CardGuardNotice from './CardGuardNotice.vue'
import CardSaveFailure from './CardSaveFailure.vue'
import CardConflictResolution from './CardConflictResolution.vue'

const COLUMNS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'done', label: '已完成' },
]

describe('CardStatusTools', () => {
  it('状态按钮点击上抛列 key；已生效列深底、待保存列带等待标记', async () => {
    const wrapper = mount(CardStatusTools, {
      props: { columns: COLUMNS, activeColumnKey: 'inbox', pendingColumnKey: 'done' },
    })
    await wrapper.findAll('button')[1]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['done']])

    const active = wrapper.findAll('button')[0]!
    expect(active.classes()).toContain('bg-gray-900')
    expect(active.find('.animate-pulse').exists()).toBe(false)
    const pending = wrapper.findAll('button')[1]!
    expect(pending.find('.animate-pulse').exists()).toBe(true)
    expect(pending.attributes('title')).toContain('两秒后随本卡片一起保存')
  })

  it('空列不渲染容器（节奏卡无状态工具时不占顶部空间）', () => {
    const wrapper = mount(CardStatusTools, {
      props: { columns: [], activeColumnKey: 'planned', pendingColumnKey: null },
    })
    expect(wrapper.find('[data-testid="card-status-tools"]').exists()).toBe(false)
  })
})

describe('CardConflictBar', () => {
  it('「比较并处理」发出 expand，testid 随领域前缀', async () => {
    const wrapper = mount(CardConflictBar, { props: { testidPrefix: 'plan' } })
    await wrapper.find('[data-testid="plan-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expand')).toHaveLength(1)
    expect(wrapper.text()).toContain('暂停自动保存')
  })
})

describe('CardConflictCompare', () => {
  const middle = Array.from({ length: 12 }, (_, i) => `第${i + 1}段`)
  const fields = [
    { key: 'name', label: '名称', kind: 'short' as const, mine: '我的名', disk: '磁盘名' },
    { key: 'same', label: '一致字段', kind: 'short' as const, mine: '相同', disk: '相同' },
    {
      key: 'body', label: '正文', kind: 'long' as const,
      mine: ['开头我的', ...middle, '结尾'].join('\n'),
      disk: ['开头磁盘', ...middle, '结尾'].join('\n'),
    },
  ]

  it('短字段红绿并排（我的/磁盘）；一致字段折叠为统计行', () => {
    const wrapper = mount(CardConflictCompare, { props: { conflictFields: fields } })
    expect(wrapper.text()).toContain('我的：我的名')
    expect(wrapper.text()).toContain('磁盘：磁盘名')
    expect(wrapper.text()).toContain('其余 1 个字段两版一致')
  })

  it('长字段渲染差异块（标签、统计、红绿对）；全部一致时显示一致提示', () => {
    const wrapper = mount(CardConflictCompare, { props: { conflictFields: fields } })
    expect(wrapper.text()).toContain('正文')
    expect(wrapper.text()).toContain('修改')
    expect(wrapper.findAll('.conflict-para-del').some((n) => n.text().includes('开头我的'))).toBe(true)
    expect(wrapper.findAll('.conflict-para-add').some((n) => n.text().includes('开头磁盘'))).toBe(true)

    const allSame = mount(CardConflictCompare, {
      props: { conflictFields: [fields[1]!] },
    })
    expect(allSame.text()).toContain('两个版本的字段内容一致')
  })

  it('长字段折叠隔离（同一 mount 内两个字段互不影响）', async () => {
    const two = mount(CardConflictCompare, {
      props: {
        conflictFields: [fields[2]!, { ...fields[2]!, key: 'body2', label: '正文二' }],
      },
    })
    const foldButtons = two.findAll('button').filter((b) => b.text().includes('展开'))
    expect(foldButtons.length).toBe(2)
    await foldButtons[0]!.trigger('click')
    expect(two.findAll('button').filter((b) => b.text().includes('收起')).length).toBe(1)
  })
})

describe('CardGuardNotice', () => {
  it('删除守护：恢复表单默认名带「（副本）」、空名禁用；提交与放弃出口接线', async () => {
    const wrapper = mount(CardGuardNotice, {
      props: { guard: { kind: 'deleted', trashPath: 'trash/p1.md' }, titleValue: '第一章' },
    })
    expect(wrapper.text()).toContain('已被删除并移入回收站')
    expect(wrapper.text()).toContain('trash/p1.md')
    await wrapper.find('[data-testid="card-guard-restore"]').trigger('click')
    const input = wrapper.find('input[placeholder="新卡片名称"]')
    expect((input.element as HTMLInputElement).value).toBe('第一章（副本）')

    await input.setValue('守护副本')
    await wrapper.findAll('button').find((b) => b.text() === '保存为新卡片')!.trigger('click')
    expect(wrapper.emitted('restoreAsCopy')).toEqual([['守护副本']])

    await wrapper.find('[data-testid="card-guard-discard"]').trigger('click')
    expect(wrapper.emitted('discardGuard')).toHaveLength(1)
  })

  it('重命名守护展示新位置；守护对象变化清理表单残留', async () => {
    const wrapper = mount(CardGuardNotice, {
      props: { guard: { kind: 'renamed', toPath: 'plans/new.md' }, titleValue: '第一章' },
    })
    expect(wrapper.text()).toContain('已被重命名')
    expect(wrapper.text()).toContain('plans/new.md')
    // 重命名守护同样提供恢复与放弃出口（与旧骨架一致）
    expect(wrapper.find('[data-testid="card-guard-restore"]').exists()).toBe(true)

    // 打开表单后守护对象变化（切卡）应清理表单残留
    await wrapper.find('[data-testid="card-guard-restore"]').trigger('click')
    expect(wrapper.find('input[placeholder="新卡片名称"]').exists()).toBe(true)
    await wrapper.setProps({ guard: { kind: 'renamed', toPath: 'plans/other.md' } })
    expect(wrapper.find('input[placeholder="新卡片名称"]').exists()).toBe(false)
  })
})

describe('CardSaveFailure', () => {
  it('失败原因展示（空消息退化为通用文案）；重试出口 testid 随领域前缀', async () => {
    const wrapper = mount(CardSaveFailure, {
      props: { testidPrefix: 'plan', message: '磁盘写入被拒绝' },
    })
    expect(wrapper.text()).toContain('磁盘写入被拒绝')
    await wrapper.find('[data-testid="plan-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)

    const fallback = mount(CardSaveFailure, { props: { testidPrefix: 'rhythm' } })
    expect(fallback.text()).toContain('保存失败')
    expect(fallback.text()).toContain('已保留')
  })
})

describe('CardConflictResolution', () => {
  const conflict = { probing: false, missing: false, expanded: true }

  function mountResolution(overrides: Record<string, unknown> = {}) {
    return mount(CardConflictResolution, {
      props: {
        cardId: 'p1',
        titleValue: '埋线：主角身世',
        conflict,
        conflictFields: [
          { key: 'name', label: '名称', kind: 'short' as const, mine: '我的名', disk: '磁盘名' },
        ],
        ...overrides,
      },
    })
  }

  it('卡片文案与字段比较渲染；返回出口上抛 collapse', async () => {
    const wrapper = mountResolution()
    expect(wrapper.text()).toContain('这张卡片有两个版本')
    expect(wrapper.text()).toContain('我的：我的名')
    await wrapper.findAll('button').find((b) => b.text() === '返回继续编辑')!.trigger('click')
    expect(wrapper.emitted('collapse')).toHaveLength(1)
  })

  it('读取在途不提供有损采用（探测文案代替比较区）', () => {
    const wrapper = mountResolution({ conflict: { ...conflict, probing: true } })
    expect(wrapper.text()).toContain('正在读取磁盘上的新版本')
    expect(wrapper.findAll('button').some((b) => b.text() === '采用磁盘版本')).toBe(false)
  })

  it('两种有损采用两击确认后上抛（第一击只进入确认态）', async () => {
    const wrapper = mountResolution()
    const disk = wrapper.findAll('button').find((b) => b.text() === '采用磁盘版本')!
    await disk.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toBeUndefined()
    await wrapper.findAll('button').find((b) => b.text().includes('确认放弃我的修改'))!.trigger('click')
    expect(wrapper.emitted('adoptDisk')).toHaveLength(1)

    const mine = wrapper.findAll('button').find((b) => b.text() === '采用我的内容')!
    await mine.trigger('click')
    expect(wrapper.emitted('adoptMine')).toBeUndefined()
    await wrapper.findAll('button').find((b) => b.text().includes('确认覆盖磁盘'))!.trigger('click')
    expect(wrapper.emitted('adoptMine')).toHaveLength(1)
  })

  it('副本表单：默认名带「（副本）」，提交即关表单并上抛 saveCopy', async () => {
    const wrapper = mountResolution()
    await wrapper.findAll('button').find((b) => b.text() === '将我的内容另存为新卡片')!.trigger('click')
    const input = wrapper.find('input[placeholder="新卡片名称"]')
    expect((input.element as HTMLInputElement).value).toBe('埋线：主角身世（副本）')

    await input.setValue('新伏笔副本')
    await wrapper.findAll('button').find((b) => b.text() === '保存为新卡片')!.trigger('click')
    expect(wrapper.emitted('saveCopy')).toEqual([['新伏笔副本']])
    expect(wrapper.find('input[placeholder="新卡片名称"]').exists()).toBe(false)
  })

  it('切卡清理：副本表单开合与两击确认残留随 cardId 变化清空', async () => {
    const wrapper = mountResolution()
    await wrapper.findAll('button').find((b) => b.text() === '将我的内容另存为新卡片')!.trigger('click')
    expect(wrapper.find('input[placeholder="新卡片名称"]').exists()).toBe(true)

    await wrapper.setProps({ cardId: 'p2' })
    expect(wrapper.find('input[placeholder="新卡片名称"]').exists()).toBe(false)
  })
})
