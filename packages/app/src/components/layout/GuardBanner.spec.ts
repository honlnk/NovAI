// @vitest-environment happy-dom
/**
 * 守护横幅（六个模块布局统一计划 阶段 1）：统一琥珀警示结构——标题、说明、
 * 路径行、出口与表单插槽。横幅不判断领域、不执行业务。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import GuardBanner from './GuardBanner.vue'

function mountBanner(props: Record<string, unknown> = {}) {
  return mount(GuardBanner, {
    props: {
      kind: 'deleted',
      title: '「第一章」已被 AI 删除并移入回收站',
      description: '你尚未写入正文的内容已保留，不会被自动丢弃。',
      detail: { label: '原文在回收站', value: 'trash/chapters/a.md' },
      ...props,
    },
    slots: { actions: '<button>出口按钮</button>' },
  })
}

describe('GuardBanner', () => {
  it('渲染标题、说明与路径行（title 悬停读全文）；出口由插槽注入', () => {
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="detail-guard-banner"]').attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('「第一章」已被 AI 删除并移入回收站')
    expect(wrapper.text()).toContain('不会被自动丢弃')
    const detail = wrapper.find('p.truncate')
    expect(detail.text()).toBe('原文在回收站：trash/chapters/a.md')
    expect(detail.attributes('title')).toBe('trash/chapters/a.md')
    expect(wrapper.find('button').text()).toBe('出口按钮')
  })

  it('detail 为空不渲染路径行（重命名守护无去向时）', () => {
    const wrapper = mountBanner({ detail: null })
    expect(wrapper.find('p.truncate').exists()).toBe(false)
  })

  it('form 插槽渲染在出口区下方（副本表单区）', () => {
    const wrapper = mount(GuardBanner, {
      props: { kind: 'renamed', title: 't', description: 'd', detail: null },
      slots: { actions: '<button>出口</button>', form: '<input placeholder="表单">' },
    })
    expect(wrapper.find('input[placeholder="表单"]').exists()).toBe(true)
  })
})
