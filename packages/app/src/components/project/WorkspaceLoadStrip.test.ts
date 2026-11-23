// @vitest-environment happy-dom
/**
 * 工作区载入细条（《项目打开进度与移动端授权修复计划》§5）：
 * 小说页顶部的整行细条，不定进度（无计数），以 role=status 暴露给读屏。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WorkspaceLoadStrip from './WorkspaceLoadStrip.vue'

describe('WorkspaceLoadStrip 工作区载入细条', () => {
  it('渲染固定文案与状态角色', () => {
    const wrapper = mount(WorkspaceLoadStrip)

    const strip = wrapper.find('[data-testid="workspace-load-strip"]')
    expect(strip.exists()).toBe(true)
    expect(strip.attributes('role')).toBe('status')
    expect(strip.text()).toBe('正在载入工作区…')
  })
})
