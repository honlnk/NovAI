// @vitest-environment happy-dom
/**
 * DiffLines 结构回归：行背景必须铺满整个可滚动宽度。
 * 行级 diff 的每行是不换行的块，宽度只等于滚动容器的可见宽度；窄屏（手机聊天面板约 240px）
 * 下长行一横向滚动，红绿背景就只盖住左侧一段、右侧露出灰底。结构上要求所有行挂在
 * 「撑到最宽一行、且不窄于容器」的内层里，背景才会随内容延伸到可滚动宽度。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import DiffLines from './DiffLines.vue'

const OLD_TEXT = '旧的第一行\n两边都有的行\n旧的第三行'
const NEW_TEXT = '新的第一行\n两边都有的行\n新的第三行'

function mountDiff(oldText = OLD_TEXT, newText = NEW_TEXT) {
  return mount(DiffLines, { props: { oldText, newText } })
}

describe('DiffLines', () => {
  it('行级 diff：删除行红底带 −，新增行绿底带 +，上下文行无背景无标记', () => {
    const rows = mountDiff().findAll('.whitespace-pre')
    // jsdiff 的段落顺序：删/增/上下文/删/增
    expect(rows.map((row) => row.classes())).toEqual([
      expect.arrayContaining(['bg-red-50', 'text-red-800']),
      expect.arrayContaining(['bg-green-50', 'text-green-800']),
      expect.arrayContaining(['text-gray-500']),
      expect.arrayContaining(['bg-red-50', 'text-red-800']),
      expect.arrayContaining(['bg-green-50', 'text-green-800']),
    ])
    expect(rows[2].classes()).not.toContain('bg-green-50')
    expect(rows[2].classes()).not.toContain('bg-red-50')
    expect(rows.map((row) => row.text().trim())).toEqual([
      '−旧的第一行',
      '+新的第一行',
      '两边都有的行',
      '−旧的第三行',
      '+新的第三行',
    ])
  })

  it('所有行挂在 w-max min-w-full 内层里：背景铺满可滚动宽度', () => {
    const wrapper = mountDiff()
    const scroller = wrapper.find('.overflow-x-auto')
    expect(scroller.exists()).toBe(true)
    // 滚动容器下只有这一个内层（灰底随内层走，不留在容器上）
    expect(scroller.element.children).toHaveLength(1)
    const inner = scroller.element.firstElementChild
    expect(inner?.classList.contains('w-max')).toBe(true)
    expect(inner?.classList.contains('min-w-full')).toBe(true)
    expect(inner?.classList.contains('bg-gray-50')).toBe(true)
    expect(scroller.classes()).not.toContain('bg-gray-50')
    // 行全部是内层的直接子元素
    const rows = wrapper.findAll('.whitespace-pre')
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.element.parentElement).toBe(inner)
    }
  })
})
