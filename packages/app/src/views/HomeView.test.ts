// @vitest-environment happy-dom
/**
 * 首页接线（《项目打开进度与移动端授权修复计划》§6）：
 * 打开类动作进行中入口全部置灰且点击无效；进度面板延迟 300 毫秒出现并原位替换
 * 「恢复项目」横幅；新建对话框创建期间不可关闭，进度面板显示在名称输入框下方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import {
  createProject,
  getLastProjectSummary,
  getRecentProjects,
  restoreRecentProject,
} from '@novai/core/services/project-service'
import type { LastProjectSummaryView } from '@novai/core/services/types'
import { useProjectStore } from '../stores/project'
import HomeView from './HomeView.vue'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

// happy-dom 没有 File System Access API：环境检查会判为不可用，整页替换成不支持提示
vi.mock('../composables/useEnvironmentCheck', () => ({
  useEnvironmentCheck: () => ({ report: { usable: true } }),
}))

vi.mock('@novai/core/services/project-service', () => ({
  closeProject: vi.fn(),
  createProject: vi.fn(),
  deleteRecentProject: vi.fn(),
  forgetLastProject: vi.fn(),
  getLastProjectSummary: vi.fn(),
  getRecentProjects: vi.fn(),
  isProjectAccessSupported: vi.fn(() => true),
  openProject: vi.fn(),
  refreshRecentProjectCounts: vi.fn(),
  restoreRecentProject: vi.fn(),
  restoreLastProject: vi.fn(),
  updateRecentProjectCounts: vi.fn(),
}))

vi.mock('@novai/core/services/file-service', () => ({
  readFile: vi.fn(),
  refreshFiles: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
}))

vi.mock('@novai/core/services/settings-service', () => ({
  updateConfig: vi.fn(),
}))

const SUMMARY: LastProjectSummaryView = {
  projectId: 'p-1',
  name: '上次的书',
  rootName: '上次的书',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  chapterCount: 1,
  elementCount: 0,
}

const RECENT: LastProjectSummaryView = { ...SUMMARY, projectId: 'p-2', name: '最近的书' }

/** 空文件树的最小项目（store 收尾会读 config.project.updatedAt，不能给空对象） */
function emptyProject(id: string, name: string) {
  return {
    id,
    name,
    rootName: name,
    files: [],
    config: {
      version: 1,
      project: { name, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      llm: { baseUrl: '', apiKey: '', model: '', protocol: 'openai' },
      embedding: { baseUrl: '', apiKey: '', model: '' },
      rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', mode: 'text', topN: 8 },
      completion: { enabled: false, baseUrl: '', apiKey: '', model: '', debounceMs: 300, maxTokens: 128 },
      search: { provider: 'linkseek-hosted', baseUrl: '', apiKey: '' },
      settings: {},
    },
  } as never
}

async function mountHome() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(HomeView, { global: { plugins: [pinia] } })
  const store = useProjectStore()
  await vi.advanceTimersByTimeAsync(0)
  return { wrapper, store }
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  const matched = wrapper.findAll('button').filter((b) => b.text() === text)
  expect(matched.length).toBeGreaterThan(0)
  return matched[0]
}

describe('HomeView 打开进度接线', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    push.mockReset()
    vi.mocked(getLastProjectSummary).mockResolvedValue(SUMMARY)
    vi.mocked(getRecentProjects).mockResolvedValue([SUMMARY, RECENT])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('进行中：全部入口置灰，最近卡片点击无效', async () => {
    const { wrapper, store } = await mountHome()

    // 未进行中：可点击
    expect(findButton(wrapper, '新建项目').attributes('disabled')).toBeUndefined()
    expect(findButton(wrapper, '打开项目').attributes('disabled')).toBeUndefined()

    store.loadProgress = { action: 'restore', phase: 'permission', percent: 0 }
    await nextTick()

    expect(findButton(wrapper, '新建项目').attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, '打开项目').attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, '恢复项目').attributes('disabled')).toBeDefined()

    const card = wrapper.find('[aria-label="打开项目 最近的书"]')
    expect(card.attributes('aria-disabled')).toBe('true')
    await card.trigger('click')
    expect(vi.mocked(restoreRecentProject)).not.toHaveBeenCalled()

    // 删除按钮同样置灰
    const trash = card.find('button[title="移除最近项目"]')
    expect(trash.attributes('disabled')).toBeDefined()
  })

  it('超过 300 毫秒：进度面板原位替换「恢复项目」横幅', async () => {
    const { wrapper, store } = await mountHome()
    expect(wrapper.text()).toContain('上次打开的项目')
    expect(wrapper.find('[data-testid="project-load-card"]').exists()).toBe(false)

    store.loadProgress = { action: 'restore', phase: 'permission', percent: 0, projectName: '上次的书' }
    await nextTick()

    // 不足 300 毫秒：横幅仍在（按钮已置灰），面板不闪现
    expect(wrapper.text()).toContain('上次打开的项目')
    expect(findButton(wrapper, '恢复项目').attributes('disabled')).toBeDefined()

    await vi.advanceTimersByTimeAsync(300)
    expect(wrapper.find('[data-testid="project-load-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="project-load-title"]').text()).toBe('正在打开「上次的书」…')
    expect(wrapper.text()).not.toContain('上次打开的项目')
  })

  it('新建对话框：创建期间不可关闭，进度面板出现在输入框下方', async () => {
    const { wrapper, store } = await mountHome()
    await findButton(wrapper, '新建项目').trigger('click')
    const backdrop = wrapper.find('.fixed.inset-0.z-50')
    expect(backdrop.exists()).toBe(true)

    await backdrop.find('input').setValue('新书')

    let finish!: () => void
    vi.mocked(createProject).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve(emptyProject('p-new', '新书'))
    }))
    await findButton(wrapper, '创建').trigger('click')

    // 创建中：取消置灰，遮罩与回车都关不掉
    expect(findButton(wrapper, '取消').attributes('disabled')).toBeDefined()
    await backdrop.trigger('click')
    expect(wrapper.find('input').exists()).toBe(true)
    await backdrop.find('input').setValue('新书2')
    await backdrop.find('input').trigger('keyup.enter')
    expect(vi.mocked(createProject)).toHaveBeenCalledTimes(1)

    // 超过 300 毫秒：对话框内出现进度面板（create 动作不占用横幅位置）
    await vi.advanceTimersByTimeAsync(300)
    expect(store.loadProgress).toMatchObject({ action: 'create', projectName: '新书' })
    const panels = wrapper.findAll('[data-testid="project-load-card"]')
    expect(panels).toHaveLength(1)
    expect(panels[0].find('[data-testid="project-load-title"]').text()).toBe('正在创建「新书」…')

    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(push).toHaveBeenCalledWith('/project/p-new')
  })
})
