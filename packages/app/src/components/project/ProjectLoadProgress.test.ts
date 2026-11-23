// @vitest-environment happy-dom
/**
 * 进度面板按阶段渲染（《项目打开进度与移动端授权修复计划》§5）：
 * 标题区分打开/新建/未知项目名；右侧阶段标签与明细行按计划「已拍死的取舍」第 8 条的
 * 文案表渲染；page 形态铺满屏幕。进度条数值交给 aria 供断言。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ProjectLoadProgress from './ProjectLoadProgress.vue'
import type { ProjectLoadProgressView } from '../../utils/project-load-progress'

function view(overrides: Partial<ProjectLoadProgressView>): ProjectLoadProgressView {
  return { action: 'open', phase: 'permission', percent: 0, ...overrides }
}

function mountPanel(progress: ProjectLoadProgressView, variant: 'panel' | 'page' = 'panel') {
  return mount(ProjectLoadProgress, { props: { progress, variant } })
}

describe('ProjectLoadProgress 进度面板', () => {
  it('标题：打开带项目名、新建用创建措辞、未知项目名退回通用标题', () => {
    const open = mountPanel(view({ action: 'open', projectName: '第一本小说' }))
    expect(open.find('[data-testid="project-load-title"]').text()).toBe('正在打开「第一本小说」…')

    const create = mountPanel(view({ action: 'create', projectName: '新书' }))
    expect(create.find('[data-testid="project-load-title"]').text()).toBe('正在创建「新书」…')

    const unknown = mountPanel(view({}))
    expect(unknown.find('[data-testid="project-load-title"]').text()).toBe('正在打开项目…')
  })

  it('等待授权：打开/恢复提示允许访问，新建提示选择文件夹', () => {
    const restore = mountPanel(view({ action: 'restore' }))
    expect(restore.find('[data-testid="project-load-phase"]').text()).toBe('等待授权')
    expect(restore.find('[data-testid="project-load-detail"]').text()).toBe('请在弹窗中允许访问项目文件夹')

    const create = mountPanel(view({ action: 'create' }))
    expect(create.find('[data-testid="project-load-detail"]').text()).toBe('请选择存放项目的文件夹')
  })

  it('检查项目结构：步数与刚处理完的路径；新建显示「创建项目结构」', () => {
    const open = mountPanel(view({
      phase: 'structure', percent: 10, current: 7, total: 20, currentPath: 'chapters',
    }))
    expect(open.find('[data-testid="project-load-phase"]').text()).toBe('检查项目结构')
    const openDetail = open.find('[data-testid="project-load-detail"]')
    expect(openDetail.text()).toContain('7 / 20')
    expect(openDetail.text()).toContain('chapters')

    const create = mountPanel(view({
      action: 'create', phase: 'structure', percent: 10, current: 7, total: 21, currentPath: 'prompts',
    }))
    expect(create.find('[data-testid="project-load-phase"]').text()).toBe('创建项目结构')
    const createDetail = create.find('[data-testid="project-load-detail"]')
    expect(createDetail.text()).toContain('7 / 21')
    expect(createDetail.text()).toContain('prompts')
  })

  it('扫描文件：累计计数加当前目录；根目录有专门措辞', () => {
    const scanning = mountPanel(view({
      phase: 'scan', percent: 50, files: 37, directories: 14, currentPath: 'chapters',
    }))
    expect(scanning.find('[data-testid="project-load-detail"]').text())
      .toBe('已扫描 37 个文件、14 个文件夹；正在扫描 chapters/')

    const root = mountPanel(view({
      phase: 'scan', percent: 33, files: 1, directories: 1, currentPath: '',
    }))
    expect(root.find('[data-testid="project-load-detail"]').text())
      .toBe('已扫描 1 个文件、1 个文件夹；正在扫描项目根目录')
  })

  it('即将完成：正在记录本次打开；进度条数值同步给 aria', () => {
    const wrapper = mountPanel(view({ phase: 'activate', percent: 90, projectName: '书' }))
    expect(wrapper.find('[data-testid="project-load-phase"]').text()).toBe('即将完成')
    expect(wrapper.find('[data-testid="project-load-detail"]').text()).toBe('正在记录本次打开')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('90')
  })

  it('page 形态：铺满屏幕的覆盖层；panel 形态只是卡片', () => {
    const page = mountPanel(view({ phase: 'permission' }), 'page')
    expect(page.find('[data-testid="project-load-card"]').element.parentElement?.className).toContain('fixed inset-0')

    const panel = mountPanel(view({ phase: 'permission' }), 'panel')
    expect(panel.find('[data-testid="project-load-card"]').element.parentElement?.className).not.toContain('fixed')
  })
})
