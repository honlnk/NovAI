// @vitest-environment happy-dom
/**
 * 授权卡片（《项目打开进度与移动端授权修复计划》§5）：
 * 冷启动自动恢复未获授权时留在小说页，文案按项目名已知/未知两种措辞渲染，
 * 两个出口（重新授权并打开 / 返回首页）以事件交给小说页分流。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ProjectPermissionGate from './ProjectPermissionGate.vue'

describe('ProjectPermissionGate 授权卡片', () => {
  it('项目名已知：正文点名项目「书名」', () => {
    const wrapper = mount(ProjectPermissionGate, { props: { projectName: '第一本小说' } })

    expect(wrapper.find('[data-testid="project-permission-gate"]').text()).toContain('需要重新授权')
    expect(wrapper.find('[data-testid="project-permission-gate"]').text())
      .toContain('浏览器需要你再次确认，NovAI 才能访问项目「第一本小说」的文件夹。')
  })

  it('项目名未知：正文退回「这个项目」', () => {
    const wrapper = mount(ProjectPermissionGate, { props: {} })

    expect(wrapper.find('[data-testid="project-permission-gate"]').text())
      .toContain('浏览器需要你再次确认，NovAI 才能访问这个项目的文件夹。')
  })

  it('两个出口：主按钮发 authorize，文字链接发 back', async () => {
    const wrapper = mount(ProjectPermissionGate, { props: { projectName: '书' } })

    await wrapper.find('[data-testid="project-permission-authorize"]').trigger('click')
    expect(wrapper.emitted('authorize')).toHaveLength(1)

    await wrapper.find('[data-testid="project-permission-back"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
