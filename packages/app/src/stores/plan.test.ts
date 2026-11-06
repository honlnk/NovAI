import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { PlanBoardView, PlanCardSummaryView, PlanCardView, PlanStatusView } from '@novai/core/services/types'
import { PlanConflictError } from '@novai/core/types/plans'

import {
  createPlan,
  deletePlan,
  getPlanBoard,
  readPlan,
  updatePlan,
} from '@novai/core/services/plan-service'
import { usePlanStore } from './plan'

vi.mock('@novai/core/services/plan-service', async (importOriginal) => ({
  // 纯函数（replacePlanTitleLine）保留真实实现；IO 函数 mock 掉
  ...await importOriginal<typeof import('@novai/core/services/plan-service')>(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  getPlanBoard: vi.fn(),
  listPlanCards: vi.fn(),
  readPlan: vi.fn(),
  updatePlan: vi.fn(),
}))

const mockedGetPlanBoard = vi.mocked(getPlanBoard)
const mockedReadPlan = vi.mocked(readPlan)
const mockedCreatePlan = vi.mocked(createPlan)
const mockedUpdatePlan = vi.mocked(updatePlan)
const mockedDeletePlan = vi.mocked(deletePlan)

const PROJECT = 'p-1'

function summary(id: string, status: PlanCardSummaryView['status'], order: number): PlanCardSummaryView {
  return {
    id,
    status,
    order,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    title: `卡片${id}`,
    summary: `卡片${id}`,
    sourcePath: `plans/计划-1-${id}.md`,
  }
}

function board(cards: PlanCardSummaryView[]): PlanBoardView {
  const columns: Record<PlanStatusView, PlanCardSummaryView[]> = {
    inbox: [], planned: [], 'in-progress': [], done: [], 'on-hold': [],
  }
  for (const card of cards) {
    columns[card.status].push(card)
  }
  return { columns, issues: [] }
}

function detail(id: string, body: string, overrides: Partial<PlanCardView> = {}): PlanCardView {
  return {
    id,
    status: 'inbox',
    order: 0,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    title: body.split('\n')[0] ?? '',
    summary: body.split('\n')[0] ?? '',
    body,
    sourcePath: `plans/计划-1-${id}.md`,
    contentHash: `hash-${id}`,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 手动放行的异步结果：制造「请求已发出、尚未返回」的中间态 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 走一轮宏任务，让排队的看板读取真正启动 */
const flushAsync = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
describe('plan store 看板加载与状态归并', () => {
  it('loadBoard：按状态归入五列，未加载前列为空', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 100),
      summary('c', 'on-hold', 0),
    ]))

    await store.loadBoard(PROJECT)

    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['a'])
    expect(store.board?.columns.planned.map((card) => card.id)).toEqual(['b'])
    expect(store.board?.columns['on-hold'].map((card) => card.id)).toEqual(['c'])
    expect(store.totalCardCount).toBe(3)
  })

  it('visibleColumns：默认四常驻列不含 on-hold，开筛选后只显示 on-hold', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('c', 'on-hold', 0),
    ]))
    await store.loadBoard(PROJECT)

    const defaultStatuses = store.visibleColumns.map(([status]) => status)
    expect(defaultStatuses).toEqual(['inbox', 'planned', 'in-progress', 'done'])

    store.showOnHold = true
    expect(store.visibleColumns.map(([status]) => status)).toEqual(['on-hold'])
  })

  it('loadBoard 失败：错误进 errorMessage，不清空已有数据以外的状态', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockRejectedValue(new Error('boom'))

    await store.loadBoard(PROJECT)

    expect(store.errorMessage).toBe('boom')
    expect(store.board).toBeNull()
  })
})

describe('plan store 看板加载反馈（首载骨架屏 / 后台刷新保留看板）', () => {
  it('首载期间 isLoading 且 board 仍为空：组件据此显示骨架屏而非白屏', async () => {
    const store = usePlanStore()
    const pending = deferred<PlanBoardView>()
    mockedGetPlanBoard.mockReturnValueOnce(pending.promise)

    const loading = store.loadBoard(PROJECT)
    expect(store.isLoading).toBe(true)
    expect(store.board).toBeNull()

    pending.resolve(board([summary('a', 'inbox', 0)]))
    await loading

    expect(store.isLoading).toBe(false)
    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['a'])
  })

  it('已有数据时后台刷新保留旧看板：等待期间不清空，返回后替换', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('a', 'inbox', 0)]))
    await store.loadBoard(PROJECT)

    const pending = deferred<PlanBoardView>()
    mockedGetPlanBoard.mockReturnValueOnce(pending.promise)
    const refreshing = store.refreshBoard(PROJECT)

    // 关键断言：刷新中旧看板仍在（拖动/保存后不再闪「正在读取计划…」）
    expect(store.isLoading).toBe(true)
    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['a'])

    pending.resolve(board([summary('a', 'inbox', 0), summary('b', 'planned', 0)]))
    await refreshing

    expect(store.isLoading).toBe(false)
    expect(store.board?.columns.planned.map((card) => card.id)).toEqual(['b'])
  })

  it('后台刷新失败：旧看板保留、错误进 errorMessage（可重试）', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('a', 'inbox', 0)]))
    await store.loadBoard(PROJECT)

    mockedGetPlanBoard.mockRejectedValueOnce(new Error('网络断了'))
    await store.refreshBoard(PROJECT)

    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['a'])
    expect(store.errorMessage).toBe('网络断了')
    expect(store.isLoading).toBe(false)
  })

  it('手动刷新成功短暂提示一次；自动同步成功不打扰', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.loadBoard(PROJECT)
    expect(store.manualRefreshedCount).toBe(0)

    await store.refreshBoard(PROJECT, { source: 'auto' })
    expect(store.manualRefreshedCount).toBe(0)

    await store.refreshBoard(PROJECT, { source: 'manual' })
    expect(store.manualRefreshedCount).toBe(1)
  })

  it('连续刷新合并为一段加载态并按请求顺序落板：手动刷新完成提示等全部结束', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('a', 'inbox', 0)]))
    await store.loadBoard(PROJECT)

    const first = deferred<PlanBoardView>()
    const second = deferred<PlanBoardView>()
    mockedGetPlanBoard
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const manualRefresh = store.refreshBoard(PROJECT, { source: 'manual' })
    const autoRefresh = store.refreshBoard(PROJECT)
    await flushAsync()
    // 串行排队：手动段先发，自动段排队等前一段结束（不并发打目录）
    expect(mockedGetPlanBoard).toHaveBeenCalledTimes(2)

    // 第一段（手动）返回：批次还有自动同步在跑，不提前报「已更新」
    first.resolve(board([summary('a', 'inbox', 0), summary('m', 'planned', 0)]))
    await flushAsync()
    expect(mockedGetPlanBoard).toHaveBeenCalledTimes(3)
    expect(store.isLoading).toBe(true)
    expect(store.manualRefreshedCount).toBe(0)
    expect(store.board?.columns.planned.map((card) => card.id)).toEqual(['m'])

    // 第二段（自动）返回：批次结束，按最后结果落板并补一次手动完成提示
    second.resolve(board([summary('a', 'inbox', 0), summary('n', 'planned', 0)]))
    await Promise.all([manualRefresh, autoRefresh])

    expect(store.isLoading).toBe(false)
    expect(store.board?.columns.planned.map((card) => card.id)).toEqual(['n'])
    expect(store.manualRefreshedCount).toBe(1)
  })
})

describe('plan store 正文编辑与保存', () => {
  it('updateDraft 标记未保存；saveDraft 成功后清除草稿并刷新看板', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    expect(store.hasUnsavedChanges).toBe(false)

    store.updateDraft('新正文')
    expect(store.hasUnsavedChanges).toBe(true)

    mockedUpdatePlan.mockResolvedValue(detail('a', '新正文', { updatedAt: '2026-11-03T11:00:00.000Z' }))
    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(true)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, {
      id: 'a',
      body: '新正文',
      expectedContentHash: 'hash-a',
    })
    expect(store.hasUnsavedChanges).toBe(false)
    expect(store.activeCard?.body).toBe('新正文')
    // 保存后刷新看板（服务状态归并）
    expect(mockedGetPlanBoard).toHaveBeenCalled()
  })

  it('saveDraft 冲突（外部修改）：草稿保留 + 冲突提示；重新读取后取文件内容', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('我的草稿')

    mockedUpdatePlan.mockRejectedValue(new PlanConflictError('冲突', {
      id: 'a', status: 'inbox', order: 0, createdAt: '', updatedAt: '',
      body: '外部改过的正文', sourcePath: 'plans/计划-1-a.md',
    }))
    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(false)
    expect(store.hasUnsavedChanges).toBe(true)
    expect(store.conflictNotice).not.toBeNull()
    expect(store.conflictNotice?.currentCard.body).toBe('外部改过的正文')
    expect(store.actionError).not.toBe('')

    // 用户选择「重新读取」：草稿丢弃，读取文件当前内容
    mockedReadPlan.mockResolvedValue(detail('a', '外部改过的正文', { contentHash: 'hash-a2' }))
    await store.reloadFromConflict(PROJECT)

    expect(store.conflictNotice).toBeNull()
    expect(store.activeCard?.body).toBe('外部改过的正文')
    expect(store.hasUnsavedChanges).toBe(false)
    expect(store.actionError).toBe('')
  })

  it('saveDraft 冲突后选择「保留草稿」：清提示但草稿不动', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('草稿')

    mockedUpdatePlan.mockRejectedValue(new PlanConflictError('冲突', {
      id: 'a', status: 'inbox', order: 0, createdAt: '', updatedAt: '',
      body: '外部正文', sourcePath: 'plans/计划-1-a.md',
    }))
    await store.saveDraft(PROJECT)

    store.keepDraft()

    expect(store.conflictNotice).toBeNull()
    expect(store.draftBody).toBe('草稿')
    expect(store.hasUnsavedChanges).toBe(true)
  })

  it('saveDraft 网络失败（非冲突）：草稿保留 + 错误信息', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('草稿')

    mockedUpdatePlan.mockRejectedValue(new Error('写入失败'))
    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(false)
    expect(store.draftBody).toBe('草稿')
    expect(store.actionError).toBe('写入失败')
    expect(store.conflictNotice).toBeNull()
  })

  it('isSaving 期间不重复提交', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('草稿')

    let resolveSave: (value: PlanCardView) => void = () => {}
    mockedUpdatePlan.mockReturnValue(new Promise<PlanCardView>((resolve) => { resolveSave = resolve }))

    const first = store.saveDraft(PROJECT)
    const second = await store.saveDraft(PROJECT)

    expect(second).toBe(false)
    resolveSave(detail('a', '草稿'))
    expect(await first).toBe(true)
  })
})

describe('plan store 计划名编辑与改名保存', () => {
  it('updateDraftTitle 单独改计划名：hasUnsavedChanges 置位；保存携带 title 与 hash', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 原始名称\n\n正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    expect(store.hasUnsavedChanges).toBe(false)

    store.updateDraftTitle('新名称')
    expect(store.hasUnsavedChanges).toBe(true)

    mockedUpdatePlan.mockResolvedValue(detail('a', '# 新名称\n\n正文', {
      title: '新名称',
      sourcePath: 'plans/计划-1-新名称-ab12cd34.md',
    }))
    const renamed = await store.saveDraft(PROJECT)

    expect(renamed).toBe(true)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, {
      id: 'a',
      title: '新名称',
      expectedContentHash: 'hash-a',
    })
    // 名称与正文两个草稿一次保存后全部清除
    expect(store.draftTitle).toBeNull()
    expect(store.draftBody).toBeNull()
    expect(store.hasUnsavedChanges).toBe(false)
    expect(store.activeCard?.title).toBe('新名称')
    expect(store.activeCard?.sourcePath).toBe('plans/计划-1-新名称-ab12cd34.md')
  })

  it('saveDraft 成功返回 true；sourcePath 变化由视图层对比检测（文件树刷新）', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 原始名称\n\n正文', { sourcePath: 'plans/计划-1-原slug.md' }))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    // 只改正文（路径不变）
    store.updateDraft('只改正文')
    mockedUpdatePlan.mockResolvedValue(detail('a', '只改正文', { sourcePath: 'plans/计划-1-原slug.md' }))
    const samePath = await store.saveDraft(PROJECT)
    expect(samePath).toBe(true)

    // 再改名（路径变化）：saveDraft 仍只返回成功与否
    store.updateDraftTitle('改名了')
    mockedUpdatePlan.mockResolvedValue(detail('a', '# 改名了', {
      title: '改名了',
      sourcePath: 'plans/计划-1-改名了-原slug.md',
    }))
    const renamed = await store.saveDraft(PROJECT)
    expect(renamed).toBe(true)
    expect(store.activeCard?.sourcePath).toBe('plans/计划-1-改名了-原slug.md')
  })

  it('计划名与正文同改且草稿首行是旧名称：store 先按新计划名改写首行再提交（组合责任在调用方）', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 旧名称\n\n旧正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    store.updateDraftTitle('新名称')
    // 真实场景：编辑器里的正文草稿还以旧名称开头（首行没跟着改名走）
    store.updateDraft('# 旧名称\n\n带草稿的正文')

    mockedUpdatePlan.mockResolvedValue(detail('a', '# 新名称\n\n带草稿的正文', { title: '新名称' }))
    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(true)
    // 文件名随新名称重命名的同时，正文首行必须同步改写，否则标题与文件名错位
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, {
      id: 'a',
      body: '# 新名称\n\n带草稿的正文',
      title: '新名称',
      expectedContentHash: 'hash-a',
    })
  })

  it('计划名与正文同改且草稿已自行带上新名称：组合幂等，不再重复改写', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 旧名称\n\n旧正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    store.updateDraftTitle('新名称')
    store.updateDraft('新名称\n\n新正文')

    mockedUpdatePlan.mockResolvedValue(detail('a', '新名称\n\n新正文', { title: '新名称' }))
    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(true)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, {
      id: 'a',
      body: '新名称\n\n新正文',
      title: '新名称',
      expectedContentHash: 'hash-a',
    })
  })

  it('改名失败：标题草稿与错误保留', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 原始名称\n\n正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    store.updateDraftTitle('占用名')
    mockedUpdatePlan.mockRejectedValue(new Error('目标文件已存在：plans/计划-1-占用名-x.md；请换一个计划名'))

    const ok = await store.saveDraft(PROJECT)

    expect(ok).toBe(false)
    expect(store.draftTitle).toBe('占用名')
    expect(store.hasUnsavedChanges).toBe(true)
    expect(store.actionError).toContain('目标文件已存在')
    expect(store.conflictNotice).toBeNull()
  })

  it('closeCard 彻底清理（删除路径）：草稿与会话一并清除', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '# 名称A\n\n正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraftTitle('改名草稿')

    store.closeCard()
    expect(store.draftTitle).toBeNull()
    expect(store.activeCard).toBeNull()
    expect(store.editSessions.size).toBe(0)

    store.reset()
    expect(store.draftTitle).toBeNull()
    expect(store.editSessions.size).toBe(0)
  })
})

describe('plan store 卡片级编辑会话（布局统一计划 §5）', () => {
  it('切卡保留正文草稿与编辑模式，重开同一卡片恢复', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 的未保存草稿')
    store.setDetailMode('edit')

    // 切到卡片 b：a 的草稿进入会话缓存，当前草稿让位给 b
    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    expect(store.activeCard?.id).toBe('b')
    expect(store.draftBody).toBeNull()
    expect(store.hasUnsavedChanges).toBe(false)

    // 重开 a：草稿与编辑模式恢复，未保存标记仍在
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBe('A 的未保存草稿')
    expect(store.detailMode).toBe('edit')
    expect(store.hasUnsavedChanges).toBe(true)
  })

  it('切卡保留计划名草稿，重开恢复', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', '# 名称A\n\n正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraftTitle('改名草稿')

    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    expect(store.draftTitle).toBeNull()

    mockedReadPlan.mockResolvedValueOnce(detail('a', '# 名称A\n\n正文'))
    await store.openCard(PROJECT, 'a')
    expect(store.draftTitle).toBe('改名草稿')
    expect(store.hasUnsavedChanges).toBe(true)
  })

  it('保存成功清除该卡片的会话：重开是已保存的新内容', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', '原始正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('保存掉的草稿')

    mockedUpdatePlan.mockResolvedValue(detail('a', '保存掉的草稿'))
    await store.saveDraft(PROJECT)
    expect(store.editSessions.size).toBe(0)

    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    mockedReadPlan.mockResolvedValueOnce(detail('a', '保存掉的草稿'))
    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBeNull()
    expect(store.hasUnsavedChanges).toBe(false)
  })

  it('删除卡片清除对应编辑会话', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 草稿')

    // 删除另一张带草稿的卡片前先给它留下会话：打开 b 写草稿再切走
    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 草稿')
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    expect(store.editSessions.get('b')?.body).toBe('B 草稿')

    mockedDeletePlan.mockResolvedValue({
      card: detail('b', 'B 正文'),
      trashPath: '.novel/trash/x/plans/计划-1-b.md',
    })
    await store.removeCard(PROJECT, 'b')

    expect(store.editSessions.has('b')).toBe(false)
    // 当前卡片不受影响
    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBe('A 草稿')
  })

  it('开新建不清当前卡片草稿；正在新建时点卡片切详情，新建草稿保留', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 草稿')

    store.openCreate()
    expect(store.isCreateOpen).toBe(true)
    // 当前卡片与草稿保留（取消新建可回到详情）
    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBe('A 草稿')

    store.updateCreateDraft('新建草稿名', '新建草稿正文')
    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    // 切到详情：新建面板让位但输入保留（§2.7）
    expect(store.isCreateOpen).toBe(false)
    expect(store.newCardTitle).toBe('新建草稿名')
    expect(store.newCardBody).toBe('新建草稿正文')
    expect(store.draftBody).toBeNull()
  })

  it('重开带草稿卡片且文件已被外部修改：不覆盖草稿，转冲突提示', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'inbox', 0),
      summary('b', 'planned', 0),
    ]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', '原始正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('我的草稿')
    store.setDetailMode('edit')

    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')

    // 期间文件被外部修改（新 body + 新 hash），重开 a
    mockedReadPlan.mockResolvedValueOnce(detail('a', '外部新内容', { contentHash: 'hash-a2' }))
    await store.openCard(PROJECT, 'a')

    expect(store.conflictNotice?.currentCard.body).toBe('外部新内容')
    // 草稿与编辑模式保留；hash 保持草稿基线（保存仍会命中冲突校验）
    expect(store.draftBody).toBe('我的草稿')
    expect(store.detailMode).toBe('edit')
    expect(store.activeCard?.contentHash).toBe('hash-a')

    // 保留草稿继续编辑：保存仍冲突（旧 hash），草稿不丢
    store.keepDraft()
    mockedUpdatePlan.mockRejectedValue(new PlanConflictError('冲突', {
      id: 'a', status: 'inbox', order: 0, createdAt: '', updatedAt: '',
      body: '外部新内容', sourcePath: 'plans/计划-1-a.md',
    }))
    const saved = await store.saveDraft(PROJECT)
    expect(saved).toBe(false)
    expect(store.draftBody).toBe('我的草稿')
    expect(store.conflictNotice?.currentCard.body).toBe('外部新内容')

    // 重新读取：丢弃草稿（含会话），取文件当前内容
    mockedReadPlan.mockResolvedValueOnce(detail('a', '外部新内容', { contentHash: 'hash-a2' }))
    await store.reloadFromConflict(PROJECT)
    expect(store.draftBody).toBeNull()
    expect(store.detailMode).toBe('preview')
    expect(store.activeCard?.body).toBe('外部新内容')
    expect(store.conflictNotice).toBeNull()
  })

  it('外部修改到达时无草稿的重开不受会话影响（不误报冲突）', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    mockedReadPlan.mockResolvedValueOnce(detail('a', '旧内容'))
    await store.openCard(PROJECT, 'a')

    // 用户进入编辑态但没改内容就切走再切回（会话 mode=edit、草稿为 null）
    store.setDetailMode('edit')
    mockedReadPlan.mockResolvedValueOnce(detail('a', '旧内容'))
    await store.openCard(PROJECT, 'a')
    expect(store.detailMode).toBe('edit')
    expect(store.conflictNotice).toBeNull()

    // 外部修改到达（ProjectView watch 调 openCard）：正常重读，不误报冲突
    mockedReadPlan.mockResolvedValueOnce(detail('a', '外部新内容', { contentHash: 'hash-x' }))
    await store.openCard(PROJECT, 'a')
    expect(store.activeCard?.body).toBe('外部新内容')
    expect(store.conflictNotice).toBeNull()
  })
})

describe('plan store 拖拽与状态移动', () => {
  it('moveCard 松手后本地立即移到目标位置：不等写盘与目录重扫', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValueOnce(board([
      summary('a', 'planned', 0),
      summary('b', 'planned', 100),
    ]))
    await store.loadBoard(PROJECT)

    mockedUpdatePlan.mockResolvedValue(detail('a', '正文', { status: 'planned', order: 50 }))
    mockedGetPlanBoard.mockResolvedValueOnce(board([
      summary('a', 'planned', 0),
      summary('b', 'planned', 100),
    ]))
    const moving = store.moveCard(PROJECT, 'a', 'planned', 'b')

    // 请求还没返回，看板已经显示松手后的位置（无回跳）
    expect(store.board?.columns.planned.map((card) => card.id)).toEqual(['b', 'a'])
    await moving
  })

  it('moveCard 失败：本地乐观位置被重新拉取的真实看板覆盖', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('a', 'inbox', 0)]))
    await store.loadBoard(PROJECT)

    mockedUpdatePlan.mockRejectedValue(new Error('移动失败'))
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('a', 'inbox', 0)]))
    const ok = await store.moveCard(PROJECT, 'a', 'done', null)

    expect(ok).toBe(false)
    expect(store.actionError).toBe('移动失败')
    expect(store.board?.columns.done).toEqual([])
    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['a'])
  })

  it('moveCard：传状态与 afterId（拖到某卡之后），失败后刷新看板恢复真实状态', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([
      summary('a', 'planned', 0),
      summary('b', 'planned', 100),
    ]))
    await store.loadBoard(PROJECT)

    mockedUpdatePlan.mockResolvedValue(detail('c', '正文', { status: 'planned', order: 50 }))
    const ok = await store.moveCard(PROJECT, 'c', 'planned', 'a')

    expect(ok).toBe(true)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, { id: 'c', status: 'planned', afterId: 'a' })

    // 失败路径：错误进 actionError，看板仍刷新（以文件系统为准，不假装回滚）
    mockedUpdatePlan.mockRejectedValue(new Error('移动失败'))
    const failed = await store.moveCard(PROJECT, 'c', 'done', null)

    expect(failed).toBe(false)
    expect(store.actionError).toBe('移动失败')
    expect(mockedGetPlanBoard.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('moveCard 同步当前抽屉：状态高亮、contentHash 更新，未保存草稿保留', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('未保存草稿')

    mockedUpdatePlan.mockResolvedValue(detail('a', '原始正文', { status: 'done', order: 0, contentHash: 'hash-a2' }))
    await store.moveCard(PROJECT, 'a', 'done', null)

    // 修复点：抽屉读取移动后的新状态与新哈希，看板与按钮高亮同源
    expect(store.activeCard?.status).toBe('done')
    expect(store.activeCard?.contentHash).toBe('hash-a2')
    // 草稿不被状态切换清空
    expect(store.draftBody).toBe('未保存草稿')

    // 移动后继续保存正文：携带的是移动后的新哈希（不是打开时的旧哈希）
    mockedUpdatePlan.mockResolvedValue(detail('a', '未保存草稿'))
    await store.saveDraft(PROJECT)

    expect(mockedUpdatePlan).toHaveBeenLastCalledWith(PROJECT, {
      id: 'a',
      body: '未保存草稿',
      expectedContentHash: 'hash-a2',
    })
  })

  it('moveCard 异步期间用户已切到其他卡片：不回写旧卡片详情', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', 'A 正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    let resolveMove: (value: PlanCardView) => void = () => {}
    mockedUpdatePlan.mockReturnValue(new Promise<PlanCardView>((resolve) => { resolveMove = resolve }))
    const moving = store.moveCard(PROJECT, 'a', 'done', null)

    // 移动进行中用户打开了另一张卡片
    mockedReadPlan.mockResolvedValue(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')

    resolveMove(detail('a', 'A 正文', { status: 'done' }))
    await moving

    expect(store.activeCard?.id).toBe('b')
    expect(store.activeCard?.body).toBe('B 正文')
  })
})

describe('plan store 新建与删除', () => {
  it('createCard：创建后刷新看板并打开详情', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([]))
    mockedCreatePlan.mockResolvedValue(detail('new-1', '# 新计划\n\n正文'))
    mockedReadPlan.mockResolvedValue(detail('new-1', '# 新计划\n\n正文'))

    const card = await store.createCard(PROJECT, '# 新计划\n\n正文')

    expect(card?.id).toBe('new-1')
    expect(mockedCreatePlan).toHaveBeenCalledWith(PROJECT, { body: '# 新计划\n\n正文', status: undefined })
    expect(store.selectedCardId).toBe('new-1')
    expect(store.activeCard?.body).toBe('# 新计划\n\n正文')
  })

  it('createCard 失败：返回 null 并记录错误（空正文在服务层拒绝）', async () => {
    const store = usePlanStore()
    mockedCreatePlan.mockRejectedValue(new Error('计划正文不能为空'))

    const card = await store.createCard(PROJECT, '')

    expect(card).toBeNull()
    expect(store.actionError).toBe('计划正文不能为空')
  })

  it('removeCard：删除当前打开的卡片时关闭详情', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    mockedDeletePlan.mockResolvedValue({
      card: detail('a', '正文'),
      trashPath: '.novel/trash/20261103-000000-abc/plans/计划-1-a.md',
    })
    const ok = await store.removeCard(PROJECT, 'a')

    expect(ok).toBe(true)
    expect(store.activeCard).toBeNull()
    expect(store.selectedCardId).toBeNull()
  })
})

describe('plan store 新建抽屉（三入口共用）', () => {
  it('openCreate 打开新建面板（不清当前详情）；closeCreate(discard) 清理输入', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '正文'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    store.openCreate()

    expect(store.isCreateOpen).toBe(true)
    // 布局统一计划 §2.7：新建与详情互斥展示但不互相清空，取消新建可回到详情
    expect(store.activeCard?.id).toBe('a')

    store.updateCreateDraft('新计划', '正文内容')
    expect(store.hasCreateDraft).toBe(true)

    store.closeCreate(false)
    expect(store.isCreateOpen).toBe(false)
    // 非放弃关闭：输入保留（再打开仍可继续编辑）
    expect(store.newCardTitle).toBe('新计划')

    store.openCreate()
    store.closeCreate(true)
    expect(store.newCardTitle).toBe('')
    expect(store.newCardBody).toBe('')
    expect(store.hasCreateDraft).toBe(false)
  })

  it('submitCreate：计划名 + 正文合成首个非空行结构，成功后清空并打开详情', async () => {
    const store = usePlanStore()
    mockedCreatePlan.mockResolvedValue(detail('new-1', '# 新计划\n\n正文内容'))
    mockedReadPlan.mockResolvedValue(detail('new-1', '# 新计划\n\n正文内容'))
    mockedGetPlanBoard.mockResolvedValue(board([]))

    store.updateCreateDraft('新计划', '正文内容')
    const card = await store.submitCreate(PROJECT)

    expect(card?.id).toBe('new-1')
    expect(mockedCreatePlan).toHaveBeenCalledWith(PROJECT, { body: '新计划\n\n正文内容', status: undefined })
    expect(store.isCreateOpen).toBe(false)
    expect(store.newCardTitle).toBe('')
    expect(store.newCardBody).toBe('')
    expect(store.selectedCardId).toBe('new-1')
    expect(store.activeCard?.body).toBe('# 新计划\n\n正文内容')
  })

  it('submitCreate 只有正文没有名称：直接以正文创建', async () => {
    const store = usePlanStore()
    mockedCreatePlan.mockResolvedValue(detail('new-2', '纯正文计划'))
    mockedReadPlan.mockResolvedValue(detail('new-2', '纯正文计划'))
    mockedGetPlanBoard.mockResolvedValue(board([]))

    store.updateCreateDraft('', '纯正文计划')
    const card = await store.submitCreate(PROJECT)

    expect(card?.id).toBe('new-2')
    expect(mockedCreatePlan).toHaveBeenCalledWith(PROJECT, { body: '纯正文计划', status: undefined })
  })

  it('submitCreate 失败：抽屉保持打开、输入与错误保留', async () => {
    const store = usePlanStore()
    store.openCreate()
    mockedCreatePlan.mockRejectedValue(new Error('磁盘写入失败'))

    store.updateCreateDraft('失败的计划', '还没落盘的正文')
    const card = await store.submitCreate(PROJECT)

    expect(card).toBeNull()
    expect(store.isCreateOpen).toBe(true)
    expect(store.newCardTitle).toBe('失败的计划')
    expect(store.newCardBody).toBe('还没落盘的正文')
    expect(store.actionError).toBe('磁盘写入失败')
  })

  it('submitCreate 空表单直接返回 null，不发起创建', async () => {
    const store = usePlanStore()
    store.updateCreateDraft('  ', '')

    const card = await store.submitCreate(PROJECT)

    expect(card).toBeNull()
    expect(mockedCreatePlan).not.toHaveBeenCalled()
  })

  it('isCreating 期间不重复提交', async () => {
    const store = usePlanStore()
    let resolveCreate: (value: PlanCardView) => void = () => {}
    mockedCreatePlan.mockReturnValue(new Promise<PlanCardView>((resolve) => { resolveCreate = resolve }))

    store.updateCreateDraft('A', 'B')
    const first = store.submitCreate(PROJECT)
    const second = await store.submitCreate(PROJECT)

    expect(second).toBeNull()

    resolveCreate(detail('new-3', 'A\n\nB'))
    expect((await first)?.id).toBe('new-3')
  })

  it('reset：新建抽屉状态一并清理', () => {
    const store = usePlanStore()
    store.openCreate()
    store.updateCreateDraft('x', 'y')

    store.reset()

    expect(store.isCreateOpen).toBe(false)
    expect(store.newCardTitle).toBe('')
    expect(store.newCardBody).toBe('')
    expect(store.hasCreateDraft).toBe(false)
  })
})

describe('plan store 切换项目与外部修改', () => {
  it('reset：清空全部状态（含界面状态）', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    mockedReadPlan.mockResolvedValue(detail('a', '正文'))
    await store.loadBoard(PROJECT)
    await store.openCard(PROJECT, 'a')
    store.showOnHold = true

    store.reset()

    expect(store.board).toBeNull()
    expect(store.activeCard).toBeNull()
    expect(store.showOnHold).toBe(false)
    expect(store.selectedCardId).toBeNull()
  })

  it('外部修改未在编辑时：openCard 重读最新内容（事件刷新顺序——先读后展示）', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValueOnce(detail('a', '旧内容'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')

    // 外部修改到达（模拟 ProjectView 的 watch 调 openCard）
    mockedReadPlan.mockResolvedValueOnce(detail('a', '外部新内容', { contentHash: 'hash-x' }))
    await store.openCard(PROJECT, 'a')

    expect(store.activeCard?.body).toBe('外部新内容')
    // 未编辑不产生冲突提示
    expect(store.conflictNotice).toBeNull()
  })

  it('正在编辑时，外部修改触发同卡重读仍保留草稿并提示冲突', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValueOnce(detail('a', '旧内容'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('我的草稿')

    mockedReadPlan.mockResolvedValueOnce(detail('a', '外部新内容', { contentHash: 'hash-a2' }))
    await store.openCard(PROJECT, 'a')

    expect(store.draftBody).toBe('我的草稿')
    expect(store.conflictNotice?.currentCard.body).toBe('外部新内容')
    expect(store.activeCard?.contentHash).toBe('hash-a')
  })
})

describe('plan store 异步事件序（布局统一 review 修复）', () => {
  beforeEach(() => {
    mockedGetPlanBoard.mockResolvedValue(board([]))
  })

  it('A 读取慢、B 读取快：旧请求不覆盖新选择', async () => {
    const store = usePlanStore()
    const readingA = deferred<PlanCardView>()
    mockedReadPlan.mockImplementation((_projectId, id) =>
      id === 'a' ? readingA.promise : Promise.resolve(detail(id, `${id} 正文`)),
    )

    const openA = store.openCard(PROJECT, 'a')
    const openB = store.openCard(PROJECT, 'b')
    await openB
    expect(store.activeCard?.id).toBe('b')

    readingA.resolve(detail('a', 'A 正文'))
    await openA

    expect(store.activeCard?.id).toBe('b')
    expect(store.selectedCardId).toBe('b')
  })

  it('A 读取失败晚于 B 成功：不把旧读取错误显示到当前卡片', async () => {
    const store = usePlanStore()
    const readingA = deferred<PlanCardView>()
    mockedReadPlan.mockImplementation((_projectId, id) =>
      id === 'a' ? readingA.promise : Promise.resolve(detail(id, `${id} 正文`)),
    )

    const openA = store.openCard(PROJECT, 'a')
    await store.openCard(PROJECT, 'b')
    readingA.reject(new Error('A 读取失败'))
    await openA

    expect(store.activeCard?.id).toBe('b')
    expect(store.detailError).toBeNull()
    expect(store.actionError).toBe('')
  })

  it('最后选择的卡片读取失败：错误归属于目标卡，不覆盖当前详情', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    mockedReadPlan.mockRejectedValueOnce(new Error('B 读取失败'))

    await store.openCard(PROJECT, 'b')

    expect(store.detailError).toEqual({ cardId: 'b', message: 'B 读取失败' })
    expect(store.activeCard?.id).toBe('a')
    expect(store.selectedCardId).toBe('a')
  })

  it('A→B→A：第一次 A 最后返回，不清掉后一次 A 恢复的草稿', async () => {
    const store = usePlanStore()
    const firstReadA = deferred<PlanCardView>()
    mockedReadPlan.mockReturnValueOnce(firstReadA.promise)
    const firstOpenA = store.openCard(PROJECT, 'a')

    mockedReadPlan.mockResolvedValueOnce(detail('b', 'B 正文'))
    await store.openCard(PROJECT, 'b')
    mockedReadPlan.mockResolvedValueOnce(detail('a', 'A 正文'))
    const secondOpenA = store.openCard(PROJECT, 'a')
    await secondOpenA
    store.updateDraft('后一次 A 的草稿')

    firstReadA.resolve(detail('a', 'A 正文'))
    await firstOpenA

    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBe('后一次 A 的草稿')
    expect(store.selectedCardId).toBe('a')
  })

  it('保存 A 时切到 B：A 成功返回后仍显示 B，且改名结果属于 A', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 原始`)))
    await store.openCard(PROJECT, 'a')
    store.updateDraftTitle('A 新名称')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const saveA = store.saveDraft(PROJECT)
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 的独立草稿')

    saving.resolve(detail('a', 'A 新名称', {
      title: 'A 新名称',
      sourcePath: 'plans/计划-1-A新名称-a.md',
    }))
    expect(await saveA).toBe(true)

    expect(store.activeCard?.id).toBe('b')
    expect(store.selectedCardId).toBe('b')
    expect(store.draftBody).toBe('B 的独立草稿')
    expect(store.lastSavedCard?.id).toBe('a')
    expect(store.lastSavedCard?.sourcePath).toBe('plans/计划-1-A新名称-a.md')
  })

  it('保存 A 时切到 B 再回 A：保存已提交的版本，B 的草稿不丢失', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 原始`)))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 第一批内容')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const saveA = store.saveDraft(PROJECT)
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 的独立草稿')
    const backToA = store.openCard(PROJECT, 'a')

    saving.resolve(detail('a', 'A 第一批内容', { contentHash: 'hash-a2' }))
    await Promise.all([saveA, backToA])

    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBeNull()
    expect(store.activeCard?.body).toBe('A 第一批内容')
    expect(store.editSessions.get('b')?.body).toBe('B 的独立草稿')
  })

  it('同卡保存途中继续输入：保留追加内容，保存后可继续编辑', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', 'A 原始'))
    await store.openCard(PROJECT, 'a')
    store.setDetailMode('edit')
    store.updateDraft('A 第一批已提交内容')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const save = store.saveDraft(PROJECT)
    store.updateDraft('A 第一批已提交内容\n\n保存途中追加的新草稿')

    saving.resolve(detail('a', 'A 第一批已提交内容', { contentHash: 'hash-a2' }))
    expect(await save).toBe(true)

    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBe('A 第一批已提交内容\n\n保存途中追加的新草稿')
    expect(store.hasUnsavedChanges).toBe(true)
    expect(store.detailMode).toBe('edit')
    expect(store.isSaving).toBe(false)
    expect(store.editSessions.get('a')?.baseContentHash).toBe('hash-a2')
  })

  it('保存 A 时切到 B 再回 A 后继续输入：保留 A、B 各自的新草稿', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 原始`)))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 第一批内容')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const saveA = store.saveDraft(PROJECT)
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 的独立草稿')
    const backToA = store.openCard(PROJECT, 'a')
    saving.resolve(detail('a', 'A 第一批内容', { contentHash: 'hash-a2' }))
    await Promise.all([saveA, backToA])
    store.updateDraft('A 第一批内容\n\n重开后追加内容')

    expect(store.activeCard?.id).toBe('a')
    expect(store.draftBody).toBe('A 第一批内容\n\n重开后追加内容')
    expect(store.hasUnsavedChanges).toBe(true)
    expect(store.editSessions.get('b')?.body).toBe('B 的独立草稿')
  })

  it('A 保存冲突晚于切到 B：不串冲突提示，重开 A 才显示自己的冲突', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 原始`)))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 的草稿')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const saveA = store.saveDraft(PROJECT)
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 的独立草稿')

    saving.reject(new PlanConflictError('A 发生冲突', detail('a', 'A 的外部正文')))
    expect(await saveA).toBe(false)
    expect(store.activeCard?.id).toBe('b')
    expect(store.draftBody).toBe('B 的独立草稿')
    expect(store.conflictNotice).toBeNull()
    expect(store.detailNotice?.cardId).toBe('a')
    expect(store.actionError).toBe('')

    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBe('A 的草稿')
    expect(store.actionError).toBe('A 发生冲突')
    expect(store.conflictNotice?.currentCard.body).toBe('A 的外部正文')
  })

  it('A 保存普通失败晚于切到 B：错误不显示在 B，只保留在 A 的会话', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 原始`)))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('A 的草稿')
    const saving = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValue(saving.promise)
    const saveA = store.saveDraft(PROJECT)
    await store.openCard(PROJECT, 'b')
    store.updateDraft('B 的独立草稿')

    saving.reject(new Error('A 写入失败'))
    expect(await saveA).toBe(false)
    expect(store.activeCard?.id).toBe('b')
    expect(store.draftBody).toBe('B 的独立草稿')
    expect(store.actionError).toBe('')
    expect(store.detailNotice).toEqual({ cardId: 'a', message: '「a 原始」A 写入失败' })

    await store.openCard(PROJECT, 'a')
    expect(store.actionError).toBe('A 写入失败')
    expect(store.draftBody).toBe('A 的草稿')
    expect(store.conflictNotice).toBeNull()
  })

  it('旧项目读取晚于 reset：不回写已关闭的项目', async () => {
    const store = usePlanStore()
    const reading = deferred<PlanCardView>()
    mockedReadPlan.mockReturnValue(reading.promise)
    const open = store.openCard(PROJECT, 'a')

    store.reset()
    reading.resolve(detail('a', 'P1 的旧正文'))
    await open

    expect(store.activeCard).toBeNull()
    expect(store.selectedCardId).toBeNull()
  })

  it('旧项目看板晚于新项目：不回写看板、错误或忙碌态', async () => {
    const store = usePlanStore()
    const oldBoard = deferred<PlanBoardView>()
    mockedGetPlanBoard.mockReturnValueOnce(oldBoard.promise)
    const oldLoad = store.loadBoard(PROJECT)
    await flushAsync()
    store.reset()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('b', 'inbox', 0)]))
    const newLoad = store.loadBoard('p-2')
    // 旧项目的响应此时才返回：项目代次已过，守卫拦下，不回写看板/错误/忙碌态
    oldBoard.resolve(board([summary('a', 'inbox', 0)]))
    await Promise.all([newLoad, oldLoad])

    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['b'])
    expect(store.isLoading).toBe(false)
    expect(store.errorMessage).toBe('')
  })

  it('同项目连续刷新：旧看板不覆盖新看板', async () => {
    const store = usePlanStore()
    const oldBoard = deferred<PlanBoardView>()
    mockedGetPlanBoard.mockReturnValueOnce(oldBoard.promise)
    const oldLoad = store.refreshBoard(PROJECT)
    await flushAsync()
    mockedGetPlanBoard.mockResolvedValueOnce(board([summary('b', 'inbox', 0)]))
    const newLoad = store.refreshBoard(PROJECT)
    // 旧响应此时才放行：串行队列先落新看板，旧结果晚到不再覆盖
    oldBoard.resolve(board([summary('a', 'inbox', 0)]))
    await Promise.all([newLoad, oldLoad])

    expect(store.board?.columns.inbox.map((card) => card.id)).toEqual(['b'])
    expect(store.isLoading).toBe(false)
  })

  it('创建途中切卡：创建结果不抢回详情，输入保留且可继续新建', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', 'A 正文'))
    await store.openCard(PROJECT, 'a')
    store.openCreate()
    store.updateCreateDraft('新建计划', '正文')
    const creating = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValue(creating.promise)
    const create = store.submitCreate(PROJECT)

    await store.openCard(PROJECT, 'a')
    creating.resolve(detail('new-1', '新建计划\n\n正文'))
    expect((await create)?.id).toBe('new-1')

    expect(store.activeCard?.id).toBe('a')
    expect(store.isCreateOpen).toBe(false)
    expect(store.newCardTitle).toBe('新建计划')
    expect(store.newCardBody).toBe('正文')
    expect(store.isCreating).toBe(false)
  })

  it('旧项目保存晚于新项目同 ID 保存：收尾不删新保存锁', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', 'P1 原始'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('P1 草稿')
    const oldSave = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValueOnce(oldSave.promise)
    const oldSaving = store.saveDraft(PROJECT)

    store.reset()
    mockedReadPlan.mockResolvedValue(detail('a', 'P2 原始'))
    await store.openCard('p-2', 'a')
    store.updateDraft('P2 草稿')
    const newSave = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValueOnce(newSave.promise)
    const newSaving = store.saveDraft('p-2')
    oldSave.resolve(detail('a', 'P1 草稿'))
    expect(await oldSaving).toBe(false)

    expect(store.isSaving).toBe(true)
    expect(await store.saveDraft('p-2')).toBe(false)
    newSave.resolve(detail('a', 'P2 草稿'))
    expect(await newSaving).toBe(true)
    expect(store.activeCard?.body).toBe('P2 草稿')
  })

  it('旧项目创建晚于 reset：不回写看板，也不打开旧项目详情', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([]))
    const creating = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValue(creating.promise)
    const create = store.createCard(PROJECT, '旧项目新计划')

    store.reset()
    mockedGetPlanBoard.mockClear()
    mockedReadPlan.mockClear()
    creating.resolve(detail('new-old', '旧项目新计划'))
    expect((await create)?.id).toBe('new-old')

    expect(store.board).toBeNull()
    expect(store.activeCard).toBeNull()
    expect(mockedGetPlanBoard).not.toHaveBeenCalled()
    expect(mockedReadPlan).not.toHaveBeenCalled()
  })

  it('旧项目提交新建晚于 reset：不刷新旧看板，也不抢回新建界面', async () => {
    const store = usePlanStore()
    mockedGetPlanBoard.mockResolvedValue(board([]))
    store.openCreate()
    store.updateCreateDraft('旧项目新计划', '正文')
    const creating = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValue(creating.promise)
    const create = store.submitCreate(PROJECT)

    store.reset()
    mockedGetPlanBoard.mockClear()
    creating.resolve(detail('new-old', '旧项目新计划\n\n正文'))
    expect((await create)?.id).toBe('new-old')

    expect(store.board).toBeNull()
    expect(store.activeCard).toBeNull()
    expect(store.isCreateOpen).toBe(false)
    expect(mockedGetPlanBoard).not.toHaveBeenCalled()
  })

  it('旧项目移动和删除晚于新项目：不刷新或清空新项目状态', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', 'P1 正文'))
    await store.openCard(PROJECT, 'a')
    const moving = deferred<PlanCardView>()
    const deleting = deferred<{ card: PlanCardView; trashPath: string }>()
    mockedUpdatePlan.mockReturnValue(moving.promise)
    mockedDeletePlan.mockReturnValue(deleting.promise)
    const move = store.moveCard(PROJECT, 'a', 'done', null)
    const remove = store.removeCard(PROJECT, 'a')

    store.reset()
    mockedReadPlan.mockResolvedValue(detail('b', 'P2 正文'))
    await store.openCard('p-2', 'b')
    mockedGetPlanBoard.mockClear()
    moving.resolve(detail('a', 'P1 正文', { status: 'done' }))
    deleting.resolve({ card: detail('a', 'P1 正文'), trashPath: '.novel/trash/a.md' })
    await Promise.all([move, remove])

    expect(store.activeCard?.id).toBe('b')
    expect(store.board).toBeNull()
    expect(mockedGetPlanBoard).not.toHaveBeenCalled()
  })
})
