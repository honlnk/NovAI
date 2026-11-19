import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { PlanBoardView, PlanCardSummaryView, PlanCardView, PlanStatusView } from '@novai/core/services/types'

import {
  createPlan,
  deletePlan,
  getPlanBoard,
  readPlan,
  updatePlan,
} from '@novai/core/services/plan-service'
import { usePlanStore } from './plan'
import {
  buildCardDraftKey,
  type CardBackupStore,
  flushCardBackup,
  type PersistedCardDraftRecord,
  _resetCardBackupForTest,
  _setCardBackupStoreForTest,
} from '../composables/card-backup'

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
const mockedUpdatePlan = vi.mocked(updatePlan)

const PROJECT = 'p-1'

function summary(id: string): PlanCardSummaryView {
  return {
    id,
    status: 'inbox',
    order: 0,
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

type MemoryCardStore = CardBackupStore & {
  records: Map<string, PersistedCardDraftRecord>
  deletedKeys: string[]
}

function createMemoryCardStore(): MemoryCardStore {
  const records = new Map<string, PersistedCardDraftRecord>()
  const deletedKeys: string[] = []
  return {
    records,
    deletedKeys,
    async put(record) {
      records.set(record.key, { ...record })
    },
    async delete(key) {
      records.delete(key)
      deletedKeys.push(key)
    },
    async listByProject(projectId) {
      return [...records.values()].filter(record => record.projectId === projectId)
    },
  }
}

let memoryStore: MemoryCardStore

/** 让去抖写入链（setTimeout 回调内的 promise 链）走完 */
async function drainBackupWrites(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve()
  }
}

function seedRecord(
  projectId: string,
  cardId: string,
  entry: { draft: Record<string, string | number | null>; baseContentHash?: string; mode?: 'preview' | 'edit' },
): void {
  const key = buildCardDraftKey(projectId, cardId)
  memoryStore.records.set(key, {
    key,
    projectId,
    cardId,
    draft: { ...entry.draft },
    ...(entry.baseContentHash !== undefined ? { baseContentHash: entry.baseContentHash } : {}),
    mode: entry.mode ?? 'edit',
    updatedAt: '2026-11-19T10:00:00.000Z',
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memoryStore = createMemoryCardStore()
  _setCardBackupStoreForTest(memoryStore)
})

afterEach(() => {
  _resetCardBackupForTest()
  _setCardBackupStoreForTest(null)
  vi.useRealTimers()
})

describe('卡片统一保存会话：写盘与恢复镜像', () => {
  it('输入实时进入镜像（含编辑模式与基线 hash），保存成功清除镜像', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
    store.setDetailMode('edit')
    store.updateDraft('新正文')
    vi.advanceTimersByTime(800)
    await drainBackupWrites()

    const key = buildCardDraftKey(PROJECT, 'a')
    const record = memoryStore.records.get(key)
    expect(record?.draft).toEqual({ title: null, body: '新正文' })
    expect(record?.mode).toBe('edit')
    expect(record?.baseContentHash).toBe('hash-a')

    mockedUpdatePlan.mockResolvedValue(detail('a', '新正文', { contentHash: 'hash-a2' }))
    expect(await store.saveDraft(PROJECT)).toBe(true)
    expect(memoryStore.deletedKeys).toContain(key)
    expect(store.draftBody).toBeNull()
    expect(store.editSessions.size).toBe(0)
  })

  it('草稿改回原值收敛 clean：镜像清除、会话隐藏', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('新正文')
    store.updateDraft('原始正文')
    await drainBackupWrites()

    const key = buildCardDraftKey(PROJECT, 'a')
    expect(memoryStore.deletedKeys).toContain(key)
    // 去抖写入已取消：不再落任何记录
    vi.advanceTimersByTime(800)
    await drainBackupWrites()
    expect(memoryStore.records.has(key)).toBe(false)
    expect(store.draftBody).toBeNull()
    expect(store.hasUnsavedChanges).toBe(false)
    expect(store.editSessions.size).toBe(0)
  })

  it('切卡保留字段草稿与编辑模式，重开恢复', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 正文`)))
    await store.openCard(PROJECT, 'a')
    store.setDetailMode('edit')
    store.updateDraftTitle('新标题')
    store.updateDraft('A 草稿')
    vi.advanceTimersByTime(800)
    await drainBackupWrites()

    await store.openCard(PROJECT, 'b')
    expect(store.draftBody).toBeNull()
    expect(store.editSessions.get('a')?.body).toBe('A 草稿')

    await store.openCard(PROJECT, 'a')
    expect(store.draftTitle).toBe('新标题')
    expect(store.draftBody).toBe('A 草稿')
    expect(store.detailMode).toBe('edit')
    // 重开基线一致不触发冲突
    expect(store.conflictNotice).toBeNull()
  })

  it('跨项目同 ID 卡片：会话与镜像按项目隔离互不串', async () => {
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((projectId, id) =>
      projectId === PROJECT
        ? Promise.resolve(detail(id, 'P1 正文'))
        : Promise.resolve(detail(id, 'P2 正文', { contentHash: `hash-${projectId}-${id}` })),
    )
    await store.openCard(PROJECT, 'a')
    store.updateDraft('P1 草稿')
    await store.openCard('p-2', 'a')
    store.updateDraft('P2 草稿')

    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBe('P1 草稿')
    await store.openCard('p-2', 'a')
    expect(store.draftBody).toBe('P2 草稿')

    // 两个项目各自一条镜像记录，键不同
    await flushCardBackup()
    expect(memoryStore.records.has(buildCardDraftKey(PROJECT, 'a'))).toBe(true)
    expect(memoryStore.records.has(buildCardDraftKey('p-2', 'a'))).toBe(true)
  })

  it('保存普通失败自动补试一次：成功清错误与镜像，再失败不再打扰', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
    store.updateDraft('新正文')
    mockedUpdatePlan.mockRejectedValueOnce(new Error('暂时失败'))
    expect(await store.saveDraft(PROJECT)).toBe(false)
    expect(store.actionError).toBe('暂时失败')

    // 1000ms 后自动补试一次（本次成功）
    mockedUpdatePlan.mockResolvedValue(detail('a', '新正文', { contentHash: 'hash-a2' }))
    vi.advanceTimersByTime(1000)
    await drainBackupWrites()
    await drainBackupWrites()
    expect(mockedUpdatePlan).toHaveBeenCalledTimes(2)
    expect(store.actionError).toBe('')
    expect(store.draftBody).toBeNull()
    expect(store.activeCard?.body).toBe('新正文')
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'a'))

    // 新输入开启新保存周期：再次失败自动补试一次后停
    store.updateDraft('再次修改')
    mockedUpdatePlan.mockReset()
    mockedUpdatePlan.mockRejectedValue(new Error('持续失败'))
    expect(await store.saveDraft(PROJECT)).toBe(false)
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    // mockReset 后计数重起：手动 1 次 + 补试 1 次，之后不再自动打扰
    expect(mockedUpdatePlan).toHaveBeenCalledTimes(2)
    expect(store.actionError).toBe('持续失败')
  })
})

describe('卡片统一保存会话：浏览器恢复核对', () => {
  it('基线一致：回填草稿与编辑模式，打开卡片可见，手动保存真实落盘并清镜像', async () => {
    const store = usePlanStore()
    seedRecord(PROJECT, 'a', { draft: { title: null, body: '未落盘草稿' }, baseContentHash: 'hash-a', mode: 'edit' })
    mockedReadPlan.mockResolvedValue(detail('a', '磁盘正文'))
    mockedGetPlanBoard.mockResolvedValue(board([]))

    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.restored.map(entry => entry.key)).toEqual(['a'])
    expect(report.discarded).toEqual([])
    expect(report.conflicted).toEqual([])
    expect(report.guarded).toEqual([])
    // 恢复绝不直接写卡片文件；阶段 1 也未打开自动保存
    expect(mockedUpdatePlan).not.toHaveBeenCalled()

    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBe('未落盘草稿')
    expect(store.detailMode).toBe('edit')

    mockedUpdatePlan.mockResolvedValue(detail('a', '未落盘草稿', { contentHash: 'hash-a2' }))
    expect(await store.saveDraft(PROJECT)).toBe(true)
    // 真实卡片内容进入服务入参（计划域组合：正文 + 基线 hash；null 标题不携带）
    expect(mockedUpdatePlan).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ id: 'a', body: '未落盘草稿', expectedContentHash: 'hash-a' }),
    )
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'a'))
    expect(store.editSessions.size).toBe(0)
  })

  it('恢复内容已与磁盘一致：清冗余记录，不回填会话', async () => {
    const store = usePlanStore()
    seedRecord(PROJECT, 'a', { draft: { title: null, body: '磁盘正文' }, baseContentHash: 'hash-a' })
    mockedReadPlan.mockResolvedValue(detail('a', '磁盘正文'))

    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.discarded).toEqual([{ key: 'a' }])
    expect(report.restored).toEqual([])
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'a'))

    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBeNull()
  })

  it('恢复基线变化：建立冲突，重开不覆盖草稿并提示磁盘最新', async () => {
    const store = usePlanStore()
    seedRecord(PROJECT, 'a', { draft: { title: null, body: '我的草稿' }, baseContentHash: 'hash-old' })
    mockedReadPlan.mockResolvedValue(detail('a', '外部正文'))

    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.conflicted).toEqual([{ key: 'a' }])
    expect(report.restored).toEqual([])

    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBe('我的草稿')
    expect(store.conflictNotice?.currentCard.body).toBe('外部正文')
    // 显示卡保持草稿基线 hash：下次保存仍命中服务层校验
    expect(store.activeCard?.contentHash).toBe('hash-old')
  })

  it('恢复目标已删：进入删除守护，不自动复活也不写盘', async () => {
    const store = usePlanStore()
    seedRecord(PROJECT, 'a', { draft: { title: null, body: '草稿' }, baseContentHash: 'hash-a' })
    mockedReadPlan.mockResolvedValue(null)

    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.guarded).toEqual([{ key: 'a' }])
    expect(mockedUpdatePlan).not.toHaveBeenCalled()
  })
})
