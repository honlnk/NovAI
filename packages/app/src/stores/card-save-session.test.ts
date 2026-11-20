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
const mockedCreatePlan = vi.mocked(createPlan)

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
    // 切卡收口时用户已离开本卡，会话保留编辑模式，重开直接恢复编辑现场；
    // 保存成功不自动切预览（2026-11-20 交互修订），基线一致不触发冲突
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

describe('卡片冲突与守护（阶段 3：非阻塞版本比较）', () => {
  /** 打开卡片（自动保存开）并留下未落盘修改，返回 store */
  async function openDirtyCard(body = '原始正文', draft = '我的修改') {
    vi.useFakeTimers()
    const store = usePlanStore()
    store.setCardAutosaveEnabled(true)
    mockedReadPlan.mockResolvedValue(detail('a', body))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
    store.setDetailMode('edit')
    store.updateDraft(draft)
    return store
  }

  it('外部写盘冻结 dirty 会话：紧凑冲突条 + 冲突字段比较数据 + 草稿保留，自动保存冻结', async () => {
    const store = await openDirtyCard()
    // AI 写盘后变更链调用冻结：读取外部版本建立冲突
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    const outcome = await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    expect(outcome).toBe('conflict')
    expect(store.savePhase).toBe('conflict')
    // 紧凑条数据：未展开、探测完成、磁盘最新卡在场
    expect(store.conflictView?.expanded).toBe(false)
    expect(store.conflictView?.probing).toBe(false)
    expect(store.conflictView?.diskCard?.body).toBe('AI 改过的正文')
    // 字段比较：mine = 磁盘基线 + 草稿覆盖，disk = 外部版本
    const bodyField = store.conflictFields.find((field) => field.key === 'body')
    expect(bodyField?.kind).toBe('long')
    expect(bodyField?.mine).toBe('我的修改')
    expect(bodyField?.disk).toBe('AI 改过的正文')
    // 草稿保留、自动保存冻结（两秒后不写盘）
    expect(store.draftBody).toBe('我的修改')
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(mockedUpdatePlan).not.toHaveBeenCalled()
    // 同一冲突内的后续外部修改：conflict-refresh，冲突不堆叠
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 又改了', { contentHash: 'hash-y' }))
    expect(await store.freezeForExternalChange(PROJECT, 'a')).toBe('conflict-refresh')
    expect(store.conflictView?.diskCard?.body).toBe('AI 又改了')
  })

  it('展开比较后采用磁盘版本：先读后清，详情重开为外部内容', async () => {
    const store = await openDirtyCard()
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    // 紧凑条「比较并处理」：展开并重读磁盘最新
    store.expandCardConflict(PROJECT)
    await drainBackupWrites()
    expect(store.conflictView?.expanded).toBe(true)

    // 两击确认后「采用磁盘版本」：人工内容放弃、会话清除、详情重开
    mockedGetPlanBoard.mockClear()
    const adopted = await store.adoptDiskVersion(PROJECT)
    expect(adopted).toBe(true)
    expect(store.conflictView).toBeNull()
    expect(store.draftBody).toBeNull()
    expect(store.activeCard?.body).toBe('AI 改过的正文')
    expect(store.editSessions.size).toBe(0)
    expect(mockedGetPlanBoard).toHaveBeenCalled()
  })

  it('采用我的当前内容：覆盖写不带版本校验，成功后冲突解除、可见内容立即更新', async () => {
    const store = await openDirtyCard()
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    mockedUpdatePlan.mockResolvedValue(detail('a', '我的修改', { contentHash: 'hash-a2' }))
    const result = await store.overwriteWithMine(PROJECT)
    expect(result.ok).toBe(true)
    // 覆盖写：只带变化字段、不带 expectedContentHash
    expect(mockedUpdatePlan).toHaveBeenCalledWith(PROJECT, { id: 'a', body: '我的修改' })
    expect(store.conflictView).toBeNull()
    expect(store.savePhase).toBe('clean')
    expect(store.activeCard?.body).toBe('我的修改')
  })

  it('另存副本：用人工视角完整卡按名称新建，不覆盖原卡、不解冲突', async () => {
    const store = await openDirtyCard()
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    mockedCreatePlan.mockResolvedValue(detail('b', '副本名'))
    const copy = await store.saveConflictCopy(PROJECT, '副本名')
    expect(copy?.id).toBe('b')
    // 副本正文 = 人工视角完整卡（基线被草稿覆盖）改写首行为副本名
    expect(mockedCreatePlan).toHaveBeenCalledWith(PROJECT, { body: '副本名' })
    // 原冲突保留
    expect(store.conflictView).not.toBeNull()
    expect(store.draftBody).toBe('我的修改')
  })

  it('副本受控状态事件序：进行中置 busy 禁重复提交 → 失败回灌错误且现场保留 → 原名重试成功清错误', async () => {
    const store = await openDirtyCard()
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    // 第一次提交：创建挂起在途，busy 立即为真、错误为空
    const pending = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValueOnce(pending.promise)
    const first = store.saveConflictCopy(PROJECT, '副本名')
    expect(store.conflictCopyBusy).toBe(true)
    expect(store.conflictCopyError).toBe('')
    // 进行中重复提交被拒（防重复；不发出第二次创建）
    await expect(store.saveConflictCopy(PROJECT, '重复名')).resolves.toBeNull()
    expect(mockedCreatePlan).toHaveBeenCalledTimes(1)

    // 异步失败：busy 回落、错误与 actionError 回灌，冲突与草稿现场不动
    pending.reject(new Error('新建失败：目录写入被拒绝'))
    await expect(first).resolves.toBeNull()
    expect(store.conflictCopyBusy).toBe(false)
    expect(store.conflictCopyError).toBe('新建失败：目录写入被拒绝')
    expect(store.actionError).toBe('新建失败：目录写入被拒绝')
    expect(store.conflictView).not.toBeNull()
    expect(store.draftBody).toBe('我的修改')

    // 原名重试成功：副本返回、错误清空
    mockedCreatePlan.mockResolvedValueOnce(detail('b', '副本名'))
    await expect(store.saveConflictCopy(PROJECT, '副本名')).resolves.toMatchObject({ id: 'b' })
    expect(store.conflictCopyBusy).toBe(false)
    expect(store.conflictCopyError).toBe('')
  })

  it('跨卡副本事件序：A 在途切到 C → C 不继承 busy/错误、可另发起 → A 晚到失败不写 C 的全局错误 → 重开 A 不回显旧错误', async () => {
    const store = await openDirtyCard()
    mockedReadPlan.mockResolvedValue(detail('a', 'AI 改过的正文', { contentHash: 'hash-x' }))
    await store.freezeForExternalChange(PROJECT, 'a')
    await drainBackupWrites()

    // A 提交副本：创建挂起在途
    const pendingA = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValueOnce(pendingA.promise)
    const fromA = store.saveConflictCopy(PROJECT, '副本A')

    // 在途切到 C：C 不继承 A 的 busy/错误（受控状态按项目+卡片归属）
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 正文`)))
    await store.openCard(PROJECT, 'c')
    expect(store.activeCard?.id).toBe('c')
    expect(store.conflictCopyBusy).toBe(false)
    expect(store.conflictCopyError).toBe('')

    // C 可另发起自己的副本：A 的在途不拦截其他卡片
    const pendingC = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValueOnce(pendingC.promise)
    const fromC = store.saveConflictCopy(PROJECT, '副本C')
    expect(store.conflictCopyBusy).toBe(true)
    expect(mockedCreatePlan).toHaveBeenCalledTimes(2)

    // A 晚到失败：只结算到 A——不碰 C 的在途、不写 C 的全局错误、C 现场不动
    pendingA.reject(new Error('A 新建失败：目录写入被拒绝'))
    await expect(fromA).resolves.toBeNull()
    expect(store.activeCard?.id).toBe('c')
    expect(store.conflictCopyBusy).toBe(true)
    expect(store.conflictCopyError).toBe('')
    expect(store.actionError).toBe('')

    // C 晚到成功：正常返回副本并回落 busy
    pendingC.resolve(detail('copy-c', '副本C'))
    await expect(fromC).resolves.toMatchObject({ id: 'copy-c' })
    expect(store.conflictCopyBusy).toBe(false)
    expect(store.conflictCopyError).toBe('')

    // 重开 A：上一次已结算的副本错误不回显（冲突现场与草稿另行保留）
    await store.openCard(PROJECT, 'a')
    expect(store.conflictCopyError).toBe('')
  })

  it('守护恢复跨卡事件序：A 恢复在途切到 B 并输入 → 晚到成功只清 A 的守护会话，B 现场不动', async () => {
    const store = await openDirtyCard()
    store.setCardGuard(PROJECT, 'a', { kind: 'deleted', trashPath: '.trash/plans/计划-1-a.md' })
    expect(store.guardNotice).not.toBeNull()

    // A 从守护横幅提交「恢复为新卡片」：创建挂起在途，发起卡固定为 A
    const pending = deferred<PlanCardView>()
    mockedCreatePlan.mockReturnValueOnce(pending.promise)
    const restoring = store.restoreConflictCopy(PROJECT, '恢复副本')

    // 在途切到 B 并输入草稿（旧版全局收口会在这里被晚到成功误清）
    mockedReadPlan.mockImplementation((_projectId, id) => Promise.resolve(detail(id, `${id} 正文`)))
    await store.openCard(PROJECT, 'b')
    store.setDetailMode('edit')
    store.updateDraft('B 的新草稿')
    expect(store.activeCard?.id).toBe('b')

    // 晚到成功：只清发起卡 A 的守护会话；B 保持打开、草稿与待处理状态不动
    mockedGetPlanBoard.mockClear()
    pending.resolve(detail('copy-a', '恢复副本'))
    await expect(restoring).resolves.toMatchObject({ id: 'copy-a' })
    expect(store.activeCard?.id).toBe('b')
    expect(store.selectedCardId).toBe('b')
    expect(store.draftBody).toBe('B 的新草稿')
    expect(store.hasCardDraft(PROJECT, 'b')).toBe(true)
    expect(store.hasCardDraft(PROJECT, 'a')).toBe(false)
    expect(mockedGetPlanBoard).toHaveBeenCalled()
  })

  it('删除守护：AI 删除 dirty 卡后重开保留现场，放弃并关闭清理会话', async () => {
    const store = await openDirtyCard()
    store.setCardGuard(PROJECT, 'a', { kind: 'deleted', trashPath: '.trash/plans/计划-1-a.md' })
    expect(store.guardNotice).toEqual({ kind: 'deleted', trashPath: '.trash/plans/计划-1-a.md' })
    // 守护也算有待处理的人工内容（变更链判定口径）
    expect(store.hasCardDraft(PROJECT, 'a')).toBe(true)

    // 重开（卡片已从磁盘消失）：守护现场保留，不清理会话
    mockedReadPlan.mockResolvedValue(null)
    await store.openCard(PROJECT, 'a')
    expect(store.activeCard?.body).toBe('原始正文')
    expect(store.draftBody).toBe('我的修改')
    expect(store.detailMode).toBe('edit')
    expect(store.guardNotice).not.toBeNull()

    // 放弃并关闭：丢弃保留现场并刷新看板
    mockedGetPlanBoard.mockClear()
    store.discardGuardedSession(PROJECT)
    await drainBackupWrites()
    expect(store.activeCard).toBeNull()
    expect(store.selectedCardId).toBeNull()
    expect(store.hasCardDraft(PROJECT, 'a')).toBe(false)
    expect(mockedGetPlanBoard).toHaveBeenCalled()
  })

  it('hasCardDraft：干净会话与无会话为 false，dirty 为 true', async () => {
    const store = usePlanStore()
    vi.useFakeTimers()
    store.setCardAutosaveEnabled(true)
    mockedReadPlan.mockResolvedValue(detail('a', '原始正文'))
    mockedGetPlanBoard.mockResolvedValue(board([]))
    await store.openCard(PROJECT, 'a')
    expect(store.hasCardDraft(PROJECT, 'a')).toBe(false)
    expect(store.hasCardDraft(PROJECT, 'b')).toBe(false)

    store.updateDraft('未落盘')
    expect(store.hasCardDraft(PROJECT, 'a')).toBe(true)
  })
})
