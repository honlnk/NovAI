// @vitest-environment happy-dom
/**
 * 普通正文表面（六个模块布局统一计划 阶段 1）：预览／编辑两态容器的统一规格
 * 与警示色（伏笔作者真相）。组件只提供外壳，不接管输入状态。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import PlainBodySurface from './PlainBodySurface.vue'

function mountSurface(props: Record<string, unknown> = {}) {
  return mount(PlainBodySurface, {
    props: { variant: 'preview', ...props },
    slots: { default: '<p>正文内容</p>' },
  })
}

describe('PlainBodySurface', () => {
  it('预览态：统一外框（圆角边框、灰底、四边留白、内部滚动），插槽内容透传', () => {
    const wrapper = mountSurface()
    const classes = wrapper.find('[data-testid="detail-body-surface"]').classes()
    expect(classes).toContain('rounded-lg')
    expect(classes).toContain('border-gray-200')
    expect(classes).toContain('bg-gray-50')
    expect(classes).toContain('p-4')
    expect(classes).toContain('overflow-y-auto')
    expect(wrapper.text()).toBe('正文内容')
  })

  it('编辑态：白底窄边距且外框不滚动（textarea 自身滚动）', () => {
    const classes = mountSurface({ variant: 'edit' }).find('[data-testid="detail-body-surface"]').classes()
    expect(classes).toContain('bg-white')
    expect(classes).toContain('p-2')
    expect(classes).not.toContain('overflow-y-auto')
  })

  it('警示色（伏笔作者真相）：琥珀边框与底色', () => {
    const warning = mountSurface({ tone: 'warning' }).find('[data-testid="detail-body-surface"]').classes()
    expect(warning).toContain('border-amber-200')
    expect(warning).toContain('bg-amber-50')
    const warningEdit = mountSurface({ variant: 'edit', tone: 'warning' }).find('[data-testid="detail-body-surface"]').classes()
    expect(warningEdit).toContain('border-amber-200')
    expect(warningEdit).toContain('bg-white')
  })

  it('scroll 可显式覆盖默认（编辑态强制滚动等）', () => {
    const classes = mountSurface({ variant: 'edit', scroll: true }).find('[data-testid="detail-body-surface"]').classes()
    expect(classes).toContain('overflow-y-auto')
  })
})
