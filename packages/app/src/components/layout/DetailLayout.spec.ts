// @vitest-environment happy-dom
/**
 * 统一详情布局结构断言（六个模块布局统一计划 阶段 2）：保存状态在头部、
 * 底部为路径与完整时间、未选内容隐藏状态／切换／底部、无工具区不留空占位、
 * 冲突展开接管主内容——把 §三.2 布局规格固化为可执行验收，避免最终只看截图。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

import DetailLayout from './DetailLayout.vue'
import SaveStatusLight from './SaveStatusLight.vue'
import ViewModeToggle from './ViewModeToggle.vue'
import DetailFooterBar from './DetailFooterBar.vue'
import PanelHeader from './PanelHeader.vue'

function mountLayout(props: Record<string, unknown> = {}, slots: Record<string, string> = {}): VueWrapper {
  return mount(DetailLayout, {
    props: {
      mode: 'preview',
      hasContent: true,
      savePhase: 'clean',
      path: 'chapters/a.md',
      updatedAt: '2026-11-20T10:00:00Z',
      ...props,
    },
    slots: { content: '<p>主内容</p>', ...slots },
  })
}

describe('DetailLayout：固定组合结构', () => {
  it('渲染公共头部（PanelHeader）+ 状态灯在头部 leading + 切换在头部 actions + 底部信息行在主内容之后', () => {
    const wrapper = mountLayout({ savePhase: 'saving' })
    expect(wrapper.findComponent(PanelHeader).exists()).toBe(true)

    const light = wrapper.findComponent(SaveStatusLight)
    const toggle = wrapper.findComponent(ViewModeToggle)
    const footer = wrapper.findComponent(DetailFooterBar)
    expect(light.exists()).toBe(true)
    expect(toggle.exists()).toBe(true)
    expect(footer.exists()).toBe(true)

    // 顺序断言：头部 → 主内容 → 底部
    const headerEl = wrapper.find('header').element
    const contentText = wrapper.text()
    expect(contentText).toContain('主内容')
    expect(headerEl.compareDocumentPosition(wrapper.find('[data-testid="detail-footer-path"]').element))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // 状态灯在头部内（不再出现在底部）
    expect(headerEl.contains(light.element)).toBe(true)
  })

  it('标题插槽 / 元信息插槽注入头部；模式切换事件上抛', async () => {
    const wrapper = mountLayout(
      {},
      { title: '<input aria-label="标题输入">', meta: '<span>正文 1,000 字</span>' },
    )
    expect(wrapper.find('header input[aria-label="标题输入"]').exists()).toBe(true)
    expect(wrapper.find('header').text()).toContain('正文 1,000 字')

    await wrapper.find('[data-testid="detail-mode-edit"]').trigger('click')
    expect(wrapper.emitted('modeChange')).toEqual([['edit']])
  })
})

describe('DetailLayout：未选择内容', () => {
  it('标题用 fallback、隐藏状态灯／模式切换／整个底部；空状态仍在主内容', () => {
    const wrapper = mountLayout(
      { hasContent: false, path: null, updatedAt: null },
      { content: '<p>暂无内容</p>' },
    )
    expect(wrapper.findComponent(SaveStatusLight).exists()).toBe(false)
    expect(wrapper.findComponent(ViewModeToggle).exists()).toBe(false)
    expect(wrapper.findComponent(DetailFooterBar).exists()).toBe(false)
    expect(wrapper.find('h2').text()).toBe('内容预览')
    expect(wrapper.text()).toContain('暂无内容')
  })
})

describe('DetailLayout：区域开关', () => {
  it('无消息／工具／元信息插槽时不渲染空容器（不留占位）', () => {
    const wrapper = mountLayout()
    const html = wrapper.html()
    // 工具区容器只在有插槽时渲染
    expect(html).not.toContain('pb-2')
  })

  it('有工具插槽时渲染工具区容器（位于消息下、主内容上）', () => {
    const wrapper = mountLayout({}, { tools: '<div data-testid="tools">工具</div>' })
    expect(wrapper.find('[data-testid="tools"]').exists()).toBe(true)
  })

  it('消息插槽渲染在头部下方、工具区上方', () => {
    const wrapper = mountLayout({}, { message: '<div data-testid="msg">消息</div>', tools: '<div data-testid="tools">工具</div>' })
    expect(wrapper.find('[data-testid="msg"]').exists()).toBe(true)
    const msgPos = wrapper.find('[data-testid="msg"]').element
    const toolsPos = wrapper.find('[data-testid="tools"]').element
    expect(msgPos.compareDocumentPosition(toolsPos)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('冲突展开：替代常规工具、主内容与底部，只渲染冲突插槽', () => {
    const wrapper = mountLayout(
      { conflictExpanded: true },
      { tools: '<div data-testid="tools">工具</div>', conflict: '<div data-testid="conflict">比较</div>' },
    )
    expect(wrapper.find('[data-testid="conflict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tools"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('主内容')
    expect(wrapper.findComponent(DetailFooterBar).exists()).toBe(false)
    // 冲突展开时头部状态灯与切换仍可见（状态灯表达冲突阶段）
    expect(wrapper.findComponent(SaveStatusLight).exists()).toBe(true)
    expect(wrapper.findComponent(ViewModeToggle).exists()).toBe(true)
  })
})
