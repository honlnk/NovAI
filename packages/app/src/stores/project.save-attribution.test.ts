import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ProjectView } from '@novai/core/services/types'

import { useProjectStore } from './project'

/**
 * 手动保存的请求归属固定（数据安全计划 §3-1，自动化验收 1/3）：
 * 写盘目标项目在调用开始时固定；结果应用前核对当前项目与当前文件——
 * 等待写盘期间切到别的文件/项目，落盘结果不得写进别的项目、不得把
 * 面板拉回被保存的文件。冲突（外部修改/删除）单独判别交冲突界面。
 */

const writeFile = vi.hoisted(() => vi.fn())
const restoreRecentProject = vi.hoisted(() => vi.fn())
const closeProjectMock = vi.hoisted(() => vi.fn())

vi.mock('@novai/core/services/file-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/file-service')>()
  return {
    ...actual,
    writeFile,
    readFile: vi.fn(),
    createFile: vi.fn(),
    refreshFiles: vi.fn(),
  }
})

vi.mock('@novai/core/services/project-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/project-service')>()
  return {
    ...actual,
    restoreRecentProject,
    closeProject: closeProjectMock,
  }
})

function fakeProject(id: string, name: string): ProjectView {
  return {
    id,
    name,
    files: [],
  } as unknown as ProjectView
}

function savedView(path: string, content: string, updatedAt: string) {
  return { path, name: path.split('/').pop() ?? path, format: 'text' as const, content, updatedAt }
}

describe('projectStore.saveFile 保存归属固定', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeFile.mockReset()
  })

  it('验收3：项目甲的保存晚于项目乙的打开完成——写盘仍落在甲，不写乙项目', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    let releaseSave!: (value: ReturnType<typeof savedView>) => void
    writeFile.mockImplementation(() => new Promise((resolve) => {
      releaseSave = resolve
    }))

    const pending = store.saveFile('chapters/a.txt', '保存内容')
    // 保存等待期间切到项目乙
    store.currentProject = fakeProject('proj-乙', '乙')
    releaseSave(savedView('chapters/a.txt', '保存内容', '2026-11-08T12:00:00.000Z'))
    const outcome = await pending

    expect(outcome.ok).toBe(true)
    // 写盘目标固定为甲（调用开始时捕获），未写进乙
    expect(writeFile).toHaveBeenCalledWith(
      'proj-甲',
      'chapters/a.txt',
      '保存内容',
      expect.anything(),
    )
    // 保存期间当前文件已被切走：不把面板拉回被保存的文件
    expect(store.activeFile).toBeNull()
  })

  it('验收1：甲开始保存后切到文件乙——甲完成时乙的内容不被覆盖（不回写 activeFile）', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')
    store.activeFile = savedView('chapters/b.txt', '乙的内容', '2026-11-08T11:00:00.000Z')

    let releaseSave!: (value: ReturnType<typeof savedView>) => void
    writeFile.mockImplementation(() => new Promise((resolve) => {
      releaseSave = resolve
    }))

    const pending = store.saveFile('chapters/a.txt', '甲的保存内容', { expectedUpdatedAt: '2026-11-08T10:00:00.000Z' })
    releaseSave(savedView('chapters/a.txt', '甲的保存内容', '2026-11-08T12:00:00.000Z'))
    await pending

    // 当前文件是乙（path 不等）：甲的结果不回写，乙内容保持
    expect(store.activeFile?.path).toBe('chapters/b.txt')
    expect(store.activeFile?.content).toBe('乙的内容')
    // 版本校验参数透传（本次保存绑定的磁盘版本）
    expect(writeFile).toHaveBeenCalledWith(
      'proj-甲',
      'chapters/a.txt',
      '甲的保存内容',
      { expectedUpdatedAt: '2026-11-08T10:00:00.000Z' },
    )
  })

  it('保存完成时当前文件仍是同一文件：activeFile 更新为落盘结果（同步最新 updatedAt）', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')
    store.activeFile = savedView('chapters/a.txt', '旧内容', '2026-11-08T10:00:00.000Z')

    writeFile.mockResolvedValue(savedView('chapters/a.txt', '新内容', '2026-11-08T12:00:00.000Z'))
    const outcome = await store.saveFile('chapters/a.txt', '新内容')

    expect(outcome.ok).toBe(true)
    expect(store.activeFile?.content).toBe('新内容')
    expect(store.activeFile?.updatedAt).toBe('2026-11-08T12:00:00.000Z')
  })

  it('磁盘版本变化/文件缺失：conflict=true 判别（含 diskUpdatedAt），不写盘不置全局错误', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    const { FileSaveConflictError } = await import('@novai/core/services/file-service')
    writeFile.mockRejectedValue(new FileSaveConflictError('chapters/a.txt', 'modified', '2026-11-08T12:30:00.000Z'))
    const outcome = await store.saveFile('chapters/a.txt', '保存内容', { expectedUpdatedAt: '2026-11-08T10:00:00.000Z' })

    expect(outcome).toEqual({
      ok: false,
      conflict: true,
      message: expect.stringContaining('已被外部修改'),
      diskUpdatedAt: '2026-11-08T12:30:00.000Z',
    })
    // 冲突由面板冲突界面呈现，不算 store 级失败
    expect(store.errorMessage).toBe('')
  })

  it('force=true 整份覆盖写：不带 expectedUpdatedAt（「采用我的草稿」出口）', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    writeFile.mockResolvedValue(savedView('chapters/a.txt', '覆盖内容', '2026-11-08T12:00:00.000Z'))
    await store.saveFile('chapters/a.txt', '覆盖内容', { force: true })

    expect(writeFile).toHaveBeenCalledWith('proj-甲', 'chapters/a.txt', '覆盖内容', {})
  })
})

describe('projectStore 项目恢复代次（验收2 项目面：恢复中手动切换）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeFile.mockReset()
    restoreRecentProject.mockReset()
  })

  it('项目甲恢复慢、项目乙恢复快（发起序甲后乙）：甲晚到不覆盖乙的现场', async () => {
    const store = useProjectStore()

    let releaseA!: (value: ProjectView) => void
    let releaseB!: (value: ProjectView) => void
    restoreRecentProject
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseA = resolve
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseB = resolve
      }))

    const openA = store.openRecentProject('proj-甲')
    const openB = store.openRecentProject('proj-乙')
    releaseB(fakeProject('proj-乙', '乙'))
    await openB
    // 甲的恢复此时才完成（用户已在乙的现场）
    releaseA(fakeProject('proj-甲', '甲'))
    await openA

    expect(store.currentProject?.id).toBe('proj-乙')
  })

  it('关闭项目后晚到的恢复结果不复活已关闭现场', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-乙', '乙')
    closeProjectMock.mockResolvedValue(undefined)

    let releaseA!: (value: ProjectView) => void
    restoreRecentProject.mockImplementationOnce(() => new Promise((resolve) => {
      releaseA = resolve
    }))
    const openA = store.openRecentProject('proj-甲')
    // 恢复挂起期间用户关闭项目回到首页（closeCurrentProject 递增项目代次）
    await store.closeCurrentProject()
    releaseA(fakeProject('proj-甲', '甲'))
    await openA

    expect(store.currentProject).toBeNull()
  })
})

describe('projectStore.openFile 文件选择代次（验收2 文件面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeFile.mockReset()
  })

  it('甲慢乙快（点击序甲后乙）：甲后完成不得覆盖乙的读取结果', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    const readFile = vi.mocked((await import('@novai/core/services/file-service')).readFile)
    let releaseA!: (value: ReturnType<typeof savedView>) => void
    let releaseB!: (value: ReturnType<typeof savedView>) => void
    readFile
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseA = resolve
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseB = resolve
      }))

    const openA = store.openFile('chapters/甲.txt')
    const openB = store.openFile('chapters/乙.txt')
    releaseB(savedView('chapters/乙.txt', '乙的内容', '2026-11-08T12:00:00.000Z'))
    await openB
    releaseA(savedView('chapters/甲.txt', '甲的内容', '2026-11-08T12:00:01.000Z'))
    await openA

    // 乙是最新选择意图：面板保持乙，甲的晚到读取被丢弃
    expect(store.activeFile?.path).toBe('chapters/乙.txt')
    expect(store.activeFile?.content).toBe('乙的内容')
  })

  it('读取期间项目已切走：结果不写入新项目的面板', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    const readFile = vi.mocked((await import('@novai/core/services/file-service')).readFile)
    let releaseA!: (value: ReturnType<typeof savedView>) => void
    readFile.mockImplementationOnce(() => new Promise((resolve) => {
      releaseA = resolve
    }))

    const openA = store.openFile('chapters/甲.txt')
    store.currentProject = fakeProject('proj-乙', '乙') // 保存/读取在途切项目
    releaseA(savedView('chapters/甲.txt', '甲的内容', '2026-11-08T12:00:00.000Z'))
    await expect(openA).resolves.toBeNull()

    expect(store.activeFile).toBeNull()
  })
})

describe('projectStore 文件树刷新归属', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeFile.mockReset()
  })

  it('旧项目刷新晚到：不得把当前项目替换回旧项目快照', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')
    const refreshFiles = vi.mocked((await import('@novai/core/services/file-service')).refreshFiles)
    let releaseOld!: (value: never) => void
    refreshFiles.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
    const refreshing = store.refreshTree()
    store.currentProject = fakeProject('proj-乙', '乙')
    releaseOld([] as never)
    await refreshing
    expect(store.currentProject.id).toBe('proj-乙')
  })
})

describe('projectStore.createFileCopy 副本新建语义', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    writeFile.mockReset()
  })

  it('目标被占用：exists=true 且绝不覆盖（createFile 抛 FileExistsError 透传判别）', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')

    const { FileExistsError } = await import('@novai/core/services/file-service')
    const createFile = vi.mocked((await import('@novai/core/services/file-service')).createFile)
    createFile.mockRejectedValueOnce(new FileExistsError('chapters/a-草稿副本.txt'))

    const outcome = await store.createFileCopy('chapters/a-草稿副本.txt', '草稿内容')
    expect(outcome).toEqual({ ok: false, exists: true, message: expect.any(String) })
    // 副本路径不动 activeFile
    expect(store.activeFile).toBeNull()
  })

  it('新建成功：不触碰 activeFile（打开副本由调用方决定）', async () => {
    const store = useProjectStore()
    store.currentProject = fakeProject('proj-甲', '甲')
    store.activeFile = savedView('chapters/a.txt', '正在看的文件', '2026-11-08T11:00:00.000Z')

    const createFile = vi.mocked((await import('@novai/core/services/file-service')).createFile)
    createFile.mockResolvedValueOnce(savedView('chapters/a-草稿副本.txt', '草稿内容', '2026-11-08T12:00:00.000Z'))

    const outcome = await store.createFileCopy('chapters/a-草稿副本.txt', '草稿内容')
    expect(outcome.ok).toBe(true)
    expect(store.activeFile?.path).toBe('chapters/a.txt')
  })
})
