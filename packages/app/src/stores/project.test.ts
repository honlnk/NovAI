import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type {
  LastProjectSummaryView,
  ProjectView,
} from '@novai/core/services/types'
import type { ProjectLoadReporter, RecentProject } from '@novai/core/types/project'

import {
  createProject,
  getLastProjectSummary,
  getRecentProjects,
  openProject,
  restoreLastProject,
  restoreRecentProject,
  updateRecentProjectCounts,
} from '@novai/core/services/project-service'
import { refreshFiles } from '@novai/core/services/file-service'
import { ProjectPermissionRequiredError } from '@novai/core/types/project'
import { useProjectStore } from './project'

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
}))

vi.mock('@novai/core/services/settings-service', () => ({
  updateConfig: vi.fn(),
}))

const mockedRefreshFiles = vi.mocked(refreshFiles)
const mockedUpdateRecentProjectCounts = vi.mocked(updateRecentProjectCounts)

function createProjectView(files: ProjectView['files']): ProjectView {
  return {
    id: 'p-1',
    name: '测试书',
    rootName: '测试书',
    files,
    config: {
      version: 1,
      project: { name: '测试书', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      llm: { baseUrl: '', apiKey: '', model: '', protocol: 'openai' },
      embedding: { baseUrl: '', apiKey: '', model: '' },
      rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', mode: 'text', topN: 8 },
      completion: { enabled: false, baseUrl: '', apiKey: '', model: '', debounceMs: 300, maxTokens: 128 },
      search: { provider: 'linkseek-hosted', baseUrl: '', apiKey: '' },
      settings: {
        ragCandidateLimit: 20,
        ragContextMaxItems: 8,
        conversationTokenLimit: 12000,
        compressionKeepRecentTurns: 6,
        agentMaxTurns: 0,
        permissionPreset: 'chapter-material',
        embeddingTextVersion: 1,
        enableDebugLogging: false,
        activeOutlinePath: null,
        foreshadowingStatusMode: 'default',
        rhythmDeviationThreshold: 3,
      },
    },
  }
}

/** 两章 + 一要素 + 一提示词的目录树（prompts 不计入要素数；旧 .md 章节不计入章节数）。 */
function createTreeWithTwoChapters(): ProjectView['files'] {
  return [
    {
      name: 'chapters',
      path: 'chapters',
      kind: 'directory',
      children: [
        { name: '第001章-试炼.txt', path: 'chapters/第001章-试炼.txt', kind: 'file' },
        { name: '第002章-抉择.txt', path: 'chapters/第002章-抉择.txt', kind: 'file' },
        { name: '旧笔记.md', path: 'chapters/旧笔记.md', kind: 'file' },
      ],
    },
    {
      name: 'elements',
      path: 'elements',
      kind: 'directory',
      children: [
        { name: '角色甲.md', path: 'elements/characters/角色甲.md', kind: 'file' },
      ],
    },
    { name: 'system.md', path: 'prompts/system.md', kind: 'file' },
  ]
}

function createRecentProject(overrides: Partial<RecentProject> = {}): RecentProject {
  return {
    id: 'p-1',
    name: '测试书',
    updatedAt: '2026-01-01T00:00:00.000Z',
    chapterCount: 1,
    elementCount: 0,
    wordCount: 0,
    ...overrides,
  }
}

function createLastSummary(
  overrides: Partial<LastProjectSummaryView> = {},
): LastProjectSummaryView {
  return {
    projectId: 'p-1',
    name: '测试书',
    rootName: '测试书',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    chapterCount: 1,
    elementCount: 0,
    ...overrides,
  }
}

/** 灌入「打开项目那一刻」的旧状态：1 章 0 要素，另一项目条目不应被波及。 */
function seedStore() {
  const store = useProjectStore()
  store.currentProject = createProjectView([])
  store.recentProjects = [
    createRecentProject(),
    createRecentProject({ id: 'p-other', name: '别的书' }),
  ]
  store.lastProjectSummary = createLastSummary()
  return store
}

describe('project store 计数回写', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('文件树刷新后，内存最近项目与 last 摘要同步为新计数，并回写 IndexedDB', async () => {
    const store = seedStore()
    mockedRefreshFiles.mockResolvedValue(createTreeWithTwoChapters())
    mockedUpdateRecentProjectCounts.mockResolvedValue(undefined)

    await store.refreshTree()

    // recentProjects：本项目条目更新为 2 章 1 要素，别的项目不动
    expect(store.recentProjects).toHaveLength(2)
    expect(store.recentProjects[0]).toMatchObject({ id: 'p-1', chapterCount: 2, elementCount: 1 })
    expect(store.recentProjects[1]).toMatchObject({ id: 'p-other', chapterCount: 1, elementCount: 0 })

    // lastProjectSummary 同步（主页「恢复上次项目」提示也用新计数）
    expect(store.lastProjectSummary).toMatchObject({ projectId: 'p-1', chapterCount: 2, elementCount: 1 })

    // 落盘调用收到正确参数
    expect(mockedUpdateRecentProjectCounts).toHaveBeenCalledWith('p-1', 2, 1)
    expect(store.statusMessage).toBe('文件树已刷新')
    expect(store.errorMessage).toBe('')
  })

  it('IndexedDB 回写失败不影响文件树刷新：内存计数仍更新、不报错', async () => {
    const store = seedStore()
    mockedRefreshFiles.mockResolvedValue(createTreeWithTwoChapters())
    mockedUpdateRecentProjectCounts.mockRejectedValue(new Error('IndexedDB 不可用'))

    await store.refreshTree()

    expect(store.recentProjects[0]).toMatchObject({ id: 'p-1', chapterCount: 2, elementCount: 1 })
    expect(mockedUpdateRecentProjectCounts).toHaveBeenCalledTimes(1)
    expect(store.statusMessage).toBe('文件树已刷新')
    expect(store.errorMessage).toBe('')
  })

  it('当前项目不在最近列表时，刷新不新增条目、落盘照常执行', async () => {
    const store = useProjectStore()
    store.currentProject = createProjectView([])
    store.recentProjects = [createRecentProject({ id: 'p-other', name: '别的书' })]
    store.lastProjectSummary = null
    mockedRefreshFiles.mockResolvedValue(createTreeWithTwoChapters())
    mockedUpdateRecentProjectCounts.mockResolvedValue(undefined)

    await store.refreshTree()

    // map 不匹配：不强行插入条目；IndexedDB 侧记录不存在时由 service 静默跳过
    expect(store.recentProjects).toHaveLength(1)
    expect(mockedUpdateRecentProjectCounts).toHaveBeenCalledWith('p-1', 2, 1)
  })

  it('无当前项目时 refreshTree 直接返回，不触发扫描与回写', async () => {
    const store = useProjectStore()
    store.currentProject = null

    await store.refreshTree()

    expect(mockedRefreshFiles).not.toHaveBeenCalled()
    expect(mockedUpdateRecentProjectCounts).not.toHaveBeenCalled()
  })

  it('刷新扫描本身失败仍走既有错误路径，不回写计数', async () => {
    const store = seedStore()
    mockedRefreshFiles.mockRejectedValue(new Error('句柄失效'))

    await store.refreshTree()

    expect(store.errorMessage).toBe('句柄失效')
    expect(mockedUpdateRecentProjectCounts).not.toHaveBeenCalled()
  })
})

describe('project store 取消与授权分级反馈', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('打开项目取消目录选择：轻提醒而非红色错误，项目现场不变', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError'),
    )

    const result = await store.openExistingProject()

    expect(result).toBeNull()
    expect(store.notice).toMatchObject({ kind: 'cancelled', message: '未选择目录，项目未打开' })
    expect(store.errorMessage).toBe('')
    expect(store.currentProject).toBeNull()
  })

  it('新建项目取消目录选择：提示「未创建」', async () => {
    const store = useProjectStore()
    vi.mocked(createProject).mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError'),
    )

    await store.createNewProject('新书')

    expect(store.notice).toMatchObject({ kind: 'cancelled', message: '未选择目录，项目未创建' })
    expect(store.errorMessage).toBe('')
  })

  it('恢复上次项目权限拒绝：黄色授权提醒并携带重新授权目标', async () => {
    const store = useProjectStore()
    vi.mocked(restoreLastProject).mockRejectedValue(
      new ProjectPermissionRequiredError('项目「测试书」尚未获得目录访问权限，需要重新授权后才能打开。', '测试书'),
    )

    const result = await store.restoreLastOpenedProject()

    expect(result).toBeNull()
    expect(store.notice).toMatchObject({ kind: 'permission', retryTarget: 'last' })
    expect(store.notice?.message).toContain('测试书')
    expect(store.errorMessage).toBe('')
  })

  it('打开最近项目权限拒绝：重新授权目标指向该项目 id', async () => {
    const store = useProjectStore()
    vi.mocked(restoreRecentProject).mockRejectedValue(
      new ProjectPermissionRequiredError('项目「测试书」尚未获得目录访问权限，需要重新授权后才能打开。', '测试书'),
    )

    await store.openRecentProject('p-1')

    expect(store.notice).toMatchObject({ kind: 'permission', retryTarget: 'p-1' })
  })

  it('恢复上次项目但没有记录：中性轻提醒，不报错', async () => {
    const store = useProjectStore()
    vi.mocked(restoreLastProject).mockResolvedValue(null)

    await store.restoreLastOpenedProject()

    expect(store.notice).toMatchObject({ kind: 'info' })
    expect(store.errorMessage).toBe('')
  })

  it('真实故障仍进红色错误区，不产生轻提醒', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockRejectedValue(new Error('目录无法读取'))

    await store.openExistingProject()

    expect(store.errorMessage).toBe('目录无法读取')
    expect(store.notice).toBeNull()
  })

  it('重新执行操作先清掉旧轻提醒，成功后不残留', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockRejectedValueOnce(
      new DOMException('The user aborted a request.', 'AbortError'),
    )
    await store.openExistingProject()
    expect(store.notice).not.toBeNull()

    vi.mocked(openProject).mockResolvedValue(createProjectView([]))
    const result = await store.openExistingProject()

    expect(result).not.toBeNull()
    expect(store.notice).toBeNull()
  })
})

/**
 * 打开类动作的进度（《项目打开进度与移动端授权修复计划》§4）：
 * 动作一开始就置为「等待授权」；进度只属于最新的一次动作；结束时无论成败都清空。
 */
describe('project store 打开进度', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(createProject).mockReset()
    vi.mocked(openProject).mockReset()
    vi.mocked(restoreLastProject).mockReset()
    vi.mocked(restoreRecentProject).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('动作一开始就置为「等待授权」，首页入口随即置灰；结束后清空', async () => {
    const store = useProjectStore()
    let finish!: (project: ProjectView) => void
    vi.mocked(restoreLastProject).mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))

    const pending = store.restoreLastOpenedProject()

    expect(store.isOpenLoading).toBe(true)
    expect(store.loadProgress).toEqual({ action: 'restore', phase: 'permission', percent: 0 })

    finish(createProjectView([]))
    await pending

    expect(store.isOpenLoading).toBe(false)
    expect(store.loadProgress).toBeNull()
  })

  it('四个入口都把上报器交给核心层，并标明动作种类', async () => {
    const store = useProjectStore()
    const seen: string[] = []
    const record = (label: string) => async () => {
      seen.push(`${label}:${store.loadProgress?.action}`)
      return createProjectView([])
    }
    vi.mocked(createProject).mockImplementation(record('create'))
    vi.mocked(openProject).mockImplementation(record('open'))
    vi.mocked(restoreLastProject).mockImplementation(record('restore-last'))
    vi.mocked(restoreRecentProject).mockImplementation(record('restore-recent'))

    await store.createNewProject('新书')
    await store.openExistingProject()
    await store.restoreLastOpenedProject()
    await store.openRecentProject('p-1')

    expect(seen).toEqual([
      'create:create',
      'open:open',
      'restore-last:restore',
      'restore-recent:restore',
    ])
    expect(vi.mocked(createProject).mock.calls[0][1]?.onProgress).toBeTypeOf('function')
    expect(vi.mocked(openProject).mock.calls[0][0]?.onProgress).toBeTypeOf('function')
    expect(vi.mocked(restoreLastProject).mock.calls[0][0]?.onProgress).toBeTypeOf('function')
    expect(vi.mocked(restoreRecentProject).mock.calls[0][1]?.onProgress).toBeTypeOf('function')
  })

  it('核心层的进度事件换算成进度视图：结构按步数、扫描带计数、即将完成带项目名', async () => {
    vi.useFakeTimers()
    const store = useProjectStore()
    let report: ProjectLoadReporter = () => {}
    let finish!: (project: ProjectView) => void
    vi.mocked(restoreLastProject).mockImplementation((options) => new Promise((resolve) => {
      report = options?.onProgress ?? report
      finish = resolve
    }))

    const pending = store.restoreLastOpenedProject()

    report({ phase: 'structure', current: 1, total: 20, currentPath: 'chapters' })
    expect(store.loadProgress).toMatchObject({
      action: 'restore',
      phase: 'structure',
      percent: 5,
      current: 1,
      total: 20,
      currentPath: 'chapters',
    })

    report({ phase: 'scan', files: 37, directories: 14, currentPath: 'chapters' })
    expect(store.loadProgress).toMatchObject({ phase: 'scan', percent: 33, files: 37, directories: 14 })

    report({ phase: 'activate', current: 2, total: 2, projectName: '测试书' })
    expect(store.loadProgress).toMatchObject({ phase: 'activate', percent: 90, projectName: '测试书' })

    finish(createProjectView([]))
    await pending
    expect(store.loadProgress).toBeNull()
  })

  it('同一阶段内按 60 毫秒节流且最后一次更新生效；阶段切换立即刷新', async () => {
    vi.useFakeTimers()
    const store = useProjectStore()
    let report: ProjectLoadReporter = () => {}
    let finish!: (project: ProjectView) => void
    vi.mocked(restoreLastProject).mockImplementation((options) => new Promise((resolve) => {
      report = options?.onProgress ?? report
      finish = resolve
    }))

    const pending = store.restoreLastOpenedProject()

    // 阶段切换：立即生效
    report({ phase: 'structure', current: 1, total: 20 })
    expect(store.loadProgress).toMatchObject({ current: 1, percent: 5 })

    // 60 毫秒内的后续事件不逐次刷新，到点后显示最后一次
    report({ phase: 'structure', current: 2, total: 20 })
    report({ phase: 'structure', current: 3, total: 20 })
    expect(store.loadProgress).toMatchObject({ current: 1 })
    vi.advanceTimersByTime(60)
    expect(store.loadProgress).toMatchObject({ current: 3, percent: 8 })

    // 距上次刷新已满 60 毫秒：立即生效
    vi.advanceTimersByTime(60)
    report({ phase: 'structure', current: 4, total: 20 })
    expect(store.loadProgress).toMatchObject({ current: 4 })

    // 节流窗口内发生阶段切换：不被节流拖住
    report({ phase: 'scan', files: 1, directories: 0, currentPath: '' })
    expect(store.loadProgress).toMatchObject({ phase: 'scan', files: 1 })

    // 收尾时丢弃还没到点的节流更新
    report({ phase: 'scan', files: 2, directories: 0, currentPath: '' })
    finish(createProjectView([]))
    await pending
    vi.advanceTimersByTime(60)
    expect(store.loadProgress).toBeNull()
  })

  it('真实失败：进红色错误区，进度清空', async () => {
    const store = useProjectStore()
    vi.mocked(restoreLastProject).mockRejectedValue(new Error('目录无法读取'))

    await store.restoreLastOpenedProject()

    expect(store.errorMessage).toBe('目录无法读取')
    expect(store.isOpenLoading).toBe(false)
  })

  it('未获授权：进度清空，提醒里带上项目名', async () => {
    const store = useProjectStore()
    vi.mocked(restoreLastProject).mockRejectedValue(
      new ProjectPermissionRequiredError('项目「测试书」尚未获得目录访问权限，需要重新授权后才能打开。', '测试书'),
    )

    await store.restoreLastOpenedProject()

    expect(store.notice).toMatchObject({ kind: 'permission', retryTarget: 'last', projectName: '测试书' })
    expect(store.errorMessage).toBe('')
    expect(store.isOpenLoading).toBe(false)
  })

  it('取消目录选择：进度清空', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockRejectedValue(
      new DOMException('The user aborted a request.', 'AbortError'),
    )

    await store.openExistingProject()

    expect(store.notice).toMatchObject({ kind: 'cancelled' })
    expect(store.isOpenLoading).toBe(false)
  })

  it('打开成功后留下「刚完成一次打开」标记，小说页读取一次即清除', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockResolvedValue(createProjectView([]))
    expect(store.consumePendingWorkspaceInit()).toBe(false)

    await store.openExistingProject()

    expect(store.consumePendingWorkspaceInit()).toBe(true)
    expect(store.consumePendingWorkspaceInit()).toBe(false)
  })

  it('打开失败不留下「刚完成一次打开」标记', async () => {
    const store = useProjectStore()
    vi.mocked(openProject).mockRejectedValue(new Error('目录无法读取'))

    await store.openExistingProject()

    expect(store.consumePendingWorkspaceInit()).toBe(false)
  })

  it('进度归属：两次动作重叠时，旧动作晚到的事件不上报，结束也不清掉新动作的进度', async () => {
    const store = useProjectStore()
    const reporters: ProjectLoadReporter[] = []
    const finishers: Array<(project: ProjectView | null) => void> = []
    vi.mocked(restoreLastProject).mockImplementation((options) => new Promise((resolve) => {
      if (options?.onProgress) {
        reporters.push(options.onProgress)
      }
      finishers.push(resolve)
    }))

    const first = store.restoreLastOpenedProject()
    const second = store.restoreLastOpenedProject()
    expect(reporters).toHaveLength(2)

    // 旧动作的事件被忽略，新动作的事件照常显示
    reporters[0]({ phase: 'structure', current: 5, total: 20 })
    expect(store.loadProgress).toMatchObject({ phase: 'permission' })
    reporters[1]({ phase: 'scan', files: 3, directories: 1, currentPath: 'chapters' })
    expect(store.loadProgress).toMatchObject({ phase: 'scan', files: 3 })

    // 旧动作先结束：新动作的进度还在
    finishers[0](null)
    await first
    expect(store.isOpenLoading).toBe(true)
    expect(store.loadProgress).toMatchObject({ phase: 'scan', files: 3 })

    // 新动作结束：进度才清空
    finishers[1](createProjectView([]))
    await second
    expect(store.isOpenLoading).toBe(false)
    expect(store.loadProgress).toBeNull()
  })

  it('工作区载入状态由小说页显式开关，与打开进度互不影响', () => {
    const store = useProjectStore()

    store.setWorkspaceLoading(true)
    expect(store.isWorkspaceLoading).toBe(true)
    expect(store.isOpenLoading).toBe(false)

    store.setWorkspaceLoading(false)
    expect(store.isWorkspaceLoading).toBe(false)
  })

  it('已知项目名从动作一开始就带进进度：恢复上次、最近卡片与新建', async () => {
    const store = useProjectStore()
    vi.mocked(getLastProjectSummary).mockResolvedValue(createLastSummary({ name: '上次的书' }))
    await store.loadLastProjectSummary()
    vi.mocked(getRecentProjects).mockResolvedValue([createLastSummary({ projectId: 'p-2', name: '最近的书' })])
    await store.loadRecentProjects()
    const pending: Array<(value: unknown) => void> = []
    const hang = <T,>() => new Promise<T>((resolve) => {
      pending.push(resolve as unknown as (value: unknown) => void)
    })
    vi.mocked(restoreLastProject).mockImplementation(() => hang())
    vi.mocked(restoreRecentProject).mockImplementation(() => hang())
    vi.mocked(createProject).mockImplementation(() => hang())

    const restoreLast = store.restoreLastOpenedProject()
    expect(store.loadProgress).toMatchObject({ action: 'restore', projectName: '上次的书' })
    const restoreRecent = store.openRecentProject('p-2')
    expect(store.loadProgress).toMatchObject({ action: 'restore', projectName: '最近的书' })

    // 最近列表里没有的 id：项目名保持未知，标题退回「正在打开项目…」
    const unknown = store.openRecentProject('p-404')
    expect(store.loadProgress?.projectName).toBeUndefined()

    // 新建的项目名来自输入框
    const create = store.createNewProject('新书')
    expect(store.loadProgress).toMatchObject({ action: 'create', projectName: '新书' })

    // 前三个是恢复类（null 表示无可恢复），最后一个是新建（要给回项目对象）
    for (const resolve of pending.slice(0, -1)) {
      resolve(null)
    }
    pending[pending.length - 1](createProjectView([]))
    await Promise.allSettled([restoreLast, restoreRecent, unknown, create])
  })

  it('核心层上报的项目名（激活阶段带回真实名）覆盖预填的已知名', async () => {
    vi.useFakeTimers()
    const store = useProjectStore()
    vi.mocked(getLastProjectSummary).mockResolvedValue(createLastSummary({ name: '上次的旧名' }))
    await store.loadLastProjectSummary()
    let report: ProjectLoadReporter = () => {}
    let finish!: () => void
    vi.mocked(restoreLastProject).mockImplementation((options) => new Promise((resolve) => {
      report = options?.onProgress ?? report
      finish = () => resolve(createProjectView([]))
    }))

    const pending = store.restoreLastOpenedProject()
    expect(store.loadProgress).toMatchObject({ projectName: '上次的旧名' })

    report({ phase: 'activate', current: 2, total: 2, projectName: '真实书名' })
    expect(store.loadProgress).toMatchObject({ projectName: '真实书名' })

    finish()
    await pending
  })
})
