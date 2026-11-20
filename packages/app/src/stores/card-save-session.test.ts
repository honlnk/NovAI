import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type {
  ForeshadowingCardView,
  PlanBoardView,
  PlanCardSummaryView,
  PlanCardView,
  PlanStatusView,
} from '@novai/core/services/types'
import { PlanConflictError } from '@novai/core/types/plans'

import {
  createPlan,
  deletePlan,
  getPlanBoard,
  readPlan,
  updatePlan,
} from '@novai/core/services/plan-service'
import { usePlanStore } from './plan'
import { useForeshadowingStore } from './foreshadowing'
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
    expect(record?.draft).toEqual({ title: null, body: '新正文', status: null })
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

  it('切卡即收口落盘：待写内容立即保存，重开是已保存内容', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 正文`)))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
    store.setDetailMode('edit')
    store.updateDraftTitle('新标题')
    store.updateDraft('A 草稿')
    vi.advanceTimersByTime(800)
    await drainBackupWrites()

    // 阶段 2：切卡收口不等剩余去抖窗口，待写内容（含计划名）立即一次落盘
    const savedCard = detail('a', '新标题\n\nA 草稿', { contentHash: 'hash-a2', title: '新标题' })
    mockedUpdatePlan.mockResolvedValueOnce(savedCard)
    await store.openCard(PROJECT, 'b')
    await drainBackupWrites()
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ id: 'a', title: '新标题' }))
    // 落盘成功：会话 clean 隐藏、镜像清除
    expect(store.editSessions.size).toBe(0)
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'a'))

    await store.openCard(PROJECT, 'a')
    expect(store.draftTitle).toBeNull()
    expect(store.draftBody).toBeNull()
    // 切卡收口时用户已离开本卡（「保存成功自动回预览」只作用于用户停留的
    // 卡片），会话保留编辑模式，重开直接恢复编辑现场；基线一致不触发冲突
    expect(store.detailMode).toBe('edit')
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

  it('恢复基线一致且自动保存已开：回填即续存，两秒后自动落盘清镜像', async () => {
    vi.useFakeTimers()
    const store = usePlanStore()
    seedRecord(PROJECT, 'a', { draft: { title: null, body: '未落盘草稿' }, baseContentHash: 'hash-a', mode: 'edit' })
    mockedReadPlan.mockResolvedValue(detail('a', '磁盘正文'))
    mockedGetPlanBoard.mockResolvedValue(board([]))

    // 生产由 ProjectView 打开输入自动保存；恢复核对在打开后进行
    store.setCardAutosaveEnabled(true)
    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.restored.map(entry => entry.key)).toEqual(['a'])

    // 恢复的待写内容两秒后自动写盘（不等用户操作）
    mockedUpdatePlan.mockResolvedValueOnce(detail('a', '未落盘草稿', { contentHash: 'hash-a2' }))
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ id: 'a', body: '未落盘草稿' }))
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'a'))

    mockedReadPlan.mockResolvedValueOnce(detail('a', '未落盘草稿', { contentHash: 'hash-a2' }))
    await store.openCard(PROJECT, 'a')
    expect(store.draftBody).toBeNull()
    expect(store.activeCard?.body).toBe('未落盘草稿')
  })
})

describe('卡片详情自动保存（阶段 2：无保存心智）', () => {
  /** 打开卡片并开启自动保存（生产由 ProjectView 挂载时打开）的通用前置 */
  async function openCardWithAutosave(store: ReturnType<typeof usePlanStore>, body = '原始正文') {
    vi.useFakeTimers()
    store.setCardAutosaveEnabled(true)
    mockedReadPlan.mockResolvedValue(detail('a', body))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
  }

  it('两秒去抖：输入后两秒才保存，连续输入只提交最终快照', async () => {
    const store = usePlanStore()
    await openCardWithAutosave(store)
    mockedUpdatePlan.mockResolvedValue(detail('a', '第三段', { contentHash: 'hash-a2' }))

    store.updateDraft('第一段')
    expect(store.savePhase).toBe('pending')
    vi.advanceTimersByTime(1500)
    store.updateDraft('第二段')
    // 去抖窗口被新输入重置：仍未写盘
    vi.advanceTimersByTime(1500)
    expect(mockedUpdatePlan).not.toHaveBeenCalled()
    store.updateDraft('第三段')
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()

    expect(mockedUpdatePlan).toHaveBeenCalledTimes(1)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ id: 'a', body: '第三段' }))
    expect(store.savePhase).toBe('clean')
    expect(store.draftBody).toBeNull()
  })

  it('普通状态与内容并入同一次保存：成功前选中态与看板不动，成功后一起生效', async () => {
    const store = usePlanStore()
    await openCardWithAutosave(store)
    expect(store.activeCard?.status).toBe('inbox')

    store.updateDraftStatus('done')
    // 等待标记指向待保存状态，已生效列不变
    expect(store.draftStatus).toBe('done')
    expect(store.activeCard?.status).toBe('inbox')
    store.updateDraft('带状态的正文')

    const saved = deferred<PlanCardView>()
    mockedUpdatePlan.mockReturnValueOnce(saved.promise)
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    // 写盘在途：状态按钮等待标记仍在，正文未生效
    expect(mockedUpdatePlan).toHaveBeenCalledTimes(1)
    expect(mockedUpdatePlan).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ id: 'a', body: '带状态的正文', status: 'done' }),
    )
    expect(store.activeCard?.status).toBe('inbox')

    saved.resolve(detail('a', '带状态的正文', { status: 'done', contentHash: 'hash-a2' }))
    await drainBackupWrites()
    expect(store.activeCard?.status).toBe('done')
    expect(store.draftStatus).toBeNull()
    expect(store.savePhase).toBe('clean')
  })

  it('点击已生效状态：收敛无修改，两秒后不发起任何写入', async () => {
    const store = usePlanStore()
    await openCardWithAutosave(store)

    store.updateDraftStatus('inbox')
    expect(store.draftStatus).toBeNull()
    expect(store.savePhase).toBe('clean')

    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(mockedUpdatePlan).not.toHaveBeenCalled()
  })

  it('失败进入 failed 态：重试手动重开补试周期，成功后回到 clean', async () => {
    const store = usePlanStore()
    await openCardWithAutosave(store)

    store.updateDraft('新正文')
    mockedUpdatePlan.mockRejectedValue(new Error('写盘失败'))
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(store.savePhase).toBe('failed')
    expect(store.draftBody).toBe('新正文')

    // 自动补试一次仍失败后不再自动打扰
    vi.advanceTimersByTime(1000)
    await drainBackupWrites()
    expect(mockedUpdatePlan).toHaveBeenCalledTimes(2)

    mockedUpdatePlan.mockReset()
    mockedUpdatePlan.mockResolvedValueOnce(detail('a', '新正文', { contentHash: 'hash-a2' }))
    expect(await store.retrySave(PROJECT)).toBe(true)
    expect(store.savePhase).toBe('clean')
    expect(store.draftBody).toBeNull()
    expect(store.activeCard?.body).toBe('新正文')
  })

  it('冲突后自动保存冻结：继续输入不写盘，状态条停在 conflict', async () => {
    const store = usePlanStore()
    await openCardWithAutosave(store)

    store.updateDraft('第一批')
    mockedUpdatePlan.mockRejectedValueOnce(new PlanConflictError('冲突', {
      id: 'a', status: 'inbox', order: 0, createdAt: '', updatedAt: '',
      body: '外部改过', sourcePath: 'plans/计划-1-a.md',
    }))
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(store.savePhase).toBe('conflict')
    expect(store.conflictNotice?.currentCard.body).toBe('外部改过')

    // 冲突未决：新输入的去抖保存被拒绝（不覆盖别人）
    store.updateDraft('第二批')
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(mockedUpdatePlan).toHaveBeenCalledTimes(1)
    expect(store.savePhase).toBe('conflict')
    expect(store.draftBody).toBe('第二批')
  })
})

describe('卡片详情自动保存（阶段 2：伏笔域状态组合）', () => {
  const { getForeshadowingBoard, readForeshadowing, updateForeshadowing } = vi.hoisted(() => ({
    getForeshadowingBoard: vi.fn(),
    readForeshadowing: vi.fn(),
    updateForeshadowing: vi.fn(),
  }))

  vi.mock('@novai/core/services/foreshadowing-service', async (importOriginal) => ({
    ...await importOriginal<typeof import('@novai/core/services/foreshadowing-service')>(),
    getForeshadowingBoard,
    readForeshadowing,
    updateForeshadowing,
  }))

  const mockedReadForeshadowing = vi.mocked(readForeshadowing)
  const mockedUpdateForeshadowing = vi.mocked(updateForeshadowing)

  function foreshadowingDetail(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCardView {
    return {
      id: 'f1',
      name: '镜子里的字',
      status: 'planted',
      order: 0,
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T10:00:00.000Z',
      plantedAt: '第一卷/第一章',
      payoffWindow: null,
      isRedHerring: false,
      relatedChapters: [],
      relatedCharacters: [],
      relatedEntities: [],
      resolvedAt: null,
      abandonedReason: null,
      readerBody: '读者看到的',
      authorTruth: '作者知道的',
      summary: '读者看到的',
      sourcePath: 'foreshadowing/镜子里的字.md',
      contentHash: 'hash-f1',
      ...overrides,
    }
  }

  it('伏笔普通状态与读者视角一次写入；放弃状态不走普通自动保存入口（阶段 4 接入）', async () => {
    vi.useFakeTimers()
    const store = useForeshadowingStore()
    store.setCardAutosaveEnabled(true)
    mockedReadForeshadowing.mockResolvedValue(foreshadowingDetail())
    getForeshadowingBoard.mockResolvedValue({
      columns: {
        planted: [], hinted: [], developed: [], revealed: [], resolved: [], abandoned: [],
      },
      issues: [],
    })
    await store.openCard(PROJECT, 'f1')

    store.updateDraftStatus('hinted')
    store.updateDraftReaderView('新的读者视角')
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()

    expect(mockedUpdateForeshadowing).toHaveBeenCalledTimes(1)
    expect(mockedUpdateForeshadowing).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ id: 'f1', status: 'hinted', readerView: '新的读者视角' }),
    )
  })
})
