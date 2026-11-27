// @vitest-environment happy-dom
/**
 * CodeBlock（代码块一键复制）行为回归：复制的是去掉结尾换行的围栏原文；「已复制」
 * 窗口内连点不重复写入、到点复原；剪贴板 API 缺失或写入被拒时不装作成功。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import CodeBlock from './CodeBlock.vue'

const HTML = '<pre><code class="language-ts">const a = 1\n</code></pre>'

/** happy-dom 不带剪贴板：按需挂到 navigator 上（configurable，逐用例覆盖/清除） */
function stubClipboard(writeText?: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })
}

function mountBlock(props: { html?: string; code?: string; lang?: string } = {}) {
  return mount(CodeBlock, { props: { html: HTML, code: 'const a = 1\n', ...props } })
}

describe('CodeBlock', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    stubClipboard()
  })

  it('渲染：语言名在工具栏左侧，代码本体按 html 注入', () => {
    const wrapper = mountBlock({ lang: 'ts' })
    expect(wrapper.find('.md-code-block > div > span').text()).toBe('ts')
    expect(wrapper.find('pre code').classes()).toContain('language-ts')
    // textContent 保留 markdown-it 围栏渲染自带的结尾换行（html 原样注入）
    expect(wrapper.find('pre code').element.textContent).toBe('const a = 1\n')
    expect(wrapper.find('button').text()).toBe('复制')
    wrapper.unmount()
  })

  it('没写语言：不显示语言名，复制按钮仍靠右', () => {
    const wrapper = mountBlock()
    expect(wrapper.find('.md-code-block > div > span').exists()).toBe(false)
    // 工具栏里只剩按钮一个子元素：靠 ml-auto 顶到右侧（真机验证时发现它曾跑到左边）
    expect(wrapper.find('button').classes()).toContain('ml-auto')
    wrapper.unmount()
  })

  it('点击复制：写入去掉结尾换行的围栏原文，「已复制」1.5 秒后复原', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    stubClipboard(writeText)
    const wrapper = mountBlock({ lang: 'ts' })
    const button = wrapper.find('button')
    expect(button.attributes('aria-label')).toBe('复制代码')

    await button.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    expect(button.text()).toBe('已复制')
    expect(button.attributes('aria-label')).toBe('已复制')

    // 到点复原：取回注册的还原定时器（1500ms）手动触发
    const restoreCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 1500)
    expect(restoreCall?.[1]).toBe(1500)
    ;(restoreCall?.[0] as () => void)()
    await nextTick()
    expect(button.text()).toBe('复制')
    wrapper.unmount()
  })

  it('流式未闭合的围栏（没有结尾换行）原样复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const wrapper = mountBlock({ code: 'name: x' })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('name: x')
    wrapper.unmount()
  })

  it('「已复制」窗口内连点：不重复写入、不重置计时', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const wrapper = mountBlock()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('没有剪贴板 API：不报错，也不装作复制成功', async () => {
    stubClipboard()
    const wrapper = mountBlock()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('button').text()).toBe('复制')
    wrapper.unmount()
  })

  it('写入被拒（权限等）：静默，不装作复制成功', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    stubClipboard(writeText)
    const wrapper = mountBlock()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('button').text()).toBe('复制')
    wrapper.unmount()
  })

  it('卸载时清掉还原定时器', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    const wrapper = mountBlock()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    wrapper.unmount()
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
  })
})
