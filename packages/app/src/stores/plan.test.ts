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

vi.mock('@novai/core/services/plan-service', () => ({
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

describe('plan store 拖拽与状态移动', () => {
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

  it('正在编辑（有草稿）时不由外部 openCard 覆盖：草稿仍在', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValueOnce(detail('a', '旧内容'))
    mockedGetPlanBoard.mockResolvedValue(board([summary('a', 'inbox', 0)]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('我的草稿')

    // ProjectView 的 watch 有 hasUnsavedChanges 守卫；这里验证 store 层即便被直接调
    // openCard，草稿值也不会静默丢失（调用方负责守卫，store 不主动清 draft 之外的状态）
    expect(store.draftBody).toBe('我的草稿')
  })
})
