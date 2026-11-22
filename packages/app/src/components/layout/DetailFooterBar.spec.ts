// @vitest-environment happy-dom
/**
 * 底部信息行（六个模块布局统一计划 阶段 1）：路径与时间来自传入数据、
 * 长路径省略不挤压时间、不伪造地址。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import DetailFooterBar from './DetailFooterBar.vue'

function mountFooter(props: Record<string, unknown> = {}) {
  return mount(DetailFooterBar, {
    props: { path: 'chapters/第一卷/第001章.md', updatedAt: '2026-11-20T10:00:00Z', ...props },
  })
}

describe('DetailFooterBar', () => {
  it('左侧真实相对路径、右侧完整本地化时间，均来自传入数据', () => {
    const wrapper = mountFooter()
    expect(wrapper.find('[data-testid="detail-footer-path"]').text()).toBe('chapters/第一卷/第001章.md')
    const time = wrapper.find('[data-testid="detail-footer-time"]').text()
    expect(time).toMatch(/2026/)
    expect(time).toMatch(/:|：/)
    // 完整本地化：含月日与时分秒（不用卡片旧的「更新于 + 月日时分」短格式）
    expect(time).not.toContain('更新于')
  })

  it('长路径可压缩省略（truncate），时间栏不缩水（shrink-0）', () => {
    const wrapper = mountFooter({ path: `${'很长的目录名/'.repeat(20)}第001章.md` })
    const path = wrapper.find('[data-testid="detail-footer-path"]')
    expect(path.classes()).toContain('truncate')
    expect(path.classes()).toContain('min-w-0')
    expect(path.attributes('title')).toBe(`${'很长的目录名/'.repeat(20)}第001章.md`)
    const time = wrapper.find('[data-testid="detail-footer-time"]')
    expect(time.classes()).toContain('shrink-0')
    expect(time.classes()).toContain('whitespace-nowrap')
  })

  it('路径缺失只渲染右栏；时间缺失只渲染左栏；都不伪造占位地址', () => {
    const noPath = mountFooter({ path: null })
    expect(noPath.find('[data-testid="detail-footer-path"]').exists()).toBe(false)
    expect(noPath.find('[data-testid="detail-footer-time"]').exists()).toBe(true)

    const noTime = mountFooter({ updatedAt: null })
    expect(noTime.find('[data-testid="detail-footer-path"]').exists()).toBe(true)
    expect(noTime.find('[data-testid="detail-footer-time"]').exists()).toBe(false)
    expect(noTime.text()).not.toContain('未知')
  })
})
