// @vitest-environment happy-dom
/**
 * 冲突差异块（六个模块布局统一计划 阶段 1）：单栏差异块统一结构——上下文灰显、
 * 折叠展开、红绿变更对；折叠态跨字段隔离与 foldScope 复位。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ConflictDiffBlocks from './ConflictDiffBlocks.vue'
import { buildConflictDiff } from '../../utils/conflict-diff'

/** 产生一个折叠区的差异：中段 12 行未改动，两端各一处修改 */
function foldedDiff() {
  const middle = Array.from({ length: 12 }, (_, i) => `第${i + 1}段未改动`)
  return buildConflictDiff(
    ['开头我的', ...middle, '结尾段'].join('\n'),
    ['开头磁盘', ...middle, '结尾段'].join('\n'),
  )
}

function mountBlocks(props: Record<string, unknown> = {}) {
  return mount(ConflictDiffBlocks, { props: { diff: foldedDiff(), ...props } })
}

describe('ConflictDiffBlocks', () => {
  it('渲染红绿变更对（红=我的、绿=磁盘）与未改动上下文灰显', () => {
    const wrapper = mountBlocks()
    expect(wrapper.find('.conflict-para-del').text()).toContain('开头我的')
    expect(wrapper.find('.conflict-para-add').text()).toContain('开头磁盘')
    expect(wrapper.text()).toContain('第1段未改动')
  })

  it('未改动区默认折叠，可展开再收起', async () => {
    const wrapper = mountBlocks()
    const fold = wrapper.findAll('button').find((b) => b.text().includes('展开'))
    expect(fold).toBeDefined()
    await fold!.trigger('click')
    expect(wrapper.findAll('button').filter((b) => b.text().includes('收起')).length).toBe(1)
    await wrapper.findAll('button').find((b) => b.text().includes('收起'))!.trigger('click')
    expect(wrapper.findAll('button').filter((b) => b.text().includes('展开')).length).toBe(1)
  })

  it('折叠态跨字段隔离：同折叠号互不影响（foldPrefix）', async () => {
    const diff = foldedDiff()
    const wrapper = mount(ConflictDiffBlocks, {
      props: { diff, foldPrefix: 'a' },
    })
    const other = mount(ConflictDiffBlocks, {
      props: { diff, foldPrefix: 'b' },
    })
    await wrapper.findAll('button').find((b) => b.text().includes('展开'))!.trigger('click')
    expect(wrapper.findAll('button').filter((b) => b.text().includes('收起')).length).toBe(1)
    expect(other.findAll('button').filter((b) => b.text().includes('展开')).length).toBe(1)
  })

  it('foldScope 变化复位折叠态（冲突代次/切换对象后差异重组）', async () => {
    const wrapper = mountBlocks({ foldScope: 'card-1:gen-1' })
    await wrapper.findAll('button').find((b) => b.text().includes('展开'))!.trigger('click')
    expect(wrapper.findAll('button').filter((b) => b.text().includes('收起')).length).toBe(1)

    await wrapper.setProps({ foldScope: 'card-1:gen-2' })
    expect(wrapper.findAll('button').filter((b) => b.text().includes('展开')).length).toBe(1)
  })
})
