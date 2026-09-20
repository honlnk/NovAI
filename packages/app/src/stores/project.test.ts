import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type {
  LastProjectSummaryView,
  ProjectView,
} from '@novai/core/services/types'
import type { RecentProject } from '@novai/core/types/project'

import { updateRecentProjectCounts } from '@novai/core/services/project-service'
import { refreshFiles } from '@novai/core/services/file-service'
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
      settings: {
        ragCandidateLimit: 20,
        ragContextMaxItems: 8,
        conversationTokenLimit: 12000,
        compressionKeepRecentTurns: 6,
        agentMaxTurns: 0,
        permissionPreset: 'chapter-material',
        embeddingTextVersion: 1,
        enableDebugLogging: false,
        activeScenePromptPath: null,
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
        { name: '第001章-火中拾婴.txt', path: 'chapters/第001章-火中拾婴.txt', kind: 'file' },
        { name: '第002章-留他一命.txt', path: 'chapters/第002章-留他一命.txt', kind: 'file' },
        { name: '旧笔记.md', path: 'chapters/旧笔记.md', kind: 'file' },
      ],
    },
    {
      name: 'elements',
      path: 'elements',
      kind: 'directory',
      children: [
        { name: '云溪.md', path: 'elements/characters/云溪.md', kind: 'file' },
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
