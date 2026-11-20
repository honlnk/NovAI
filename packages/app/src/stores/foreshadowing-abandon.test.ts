/**
 * 伏笔主动放弃闭环（阶段 4，计划 §四）事件链测试：
 * - 详情进入操作态：不登记状态、不产生两秒计时器；原因非空才可确认；
 * - 确认一次调用原子提交「放弃状态 + 原因 + 基线 hash」，拖入落点随放弃一起落盘
 *   （详情内进入不带 afterId/beforeId 字段）；
 * - 字段修改在途时进入操作态：操作区立即可见、确认禁用，收口完成才可确认；
 * - 确认失败原因保留；外部修改冲突冻结确认（先处理版本关系）；
 * - 取消退出操作态、镜像清除；已填原因暂存会话，再次进入回填；
 * - 刷新恢复操作态：草稿已落盘也保留会话（引擎 keepAlive）并收敛 clean，
 *   恢复后仍待用户再次明确确认、绝不自动放弃；恢复遇外部修改与冲突并存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { ForeshadowingBoardView, ForeshadowingCardView } from '@novai/core/services/types'
import { ForeshadowingConflictError, type ForeshadowingCard } from '@novai/core/types/foreshadowing'

import { useForeshadowingStore } from './foreshadowing'
import {
  buildCardDraftKey,
  type CardBackupStore,
  type PersistedCardDraftRecord,
  _resetCardBackupForTest,
  _setCardBackupStoreForTest,
} from '../composables/card-backup'

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

const PROJECT = 'p-1'

/** 冲突错误携带的当前卡（core 层 ForeshadowingCard 形状：正文单字段 body） */
function conflictCard(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCard {
  return { ...view(overrides), body: '外部正文' } as unknown as ForeshadowingCard
}

function view(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCardView {
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

function emptyBoard(): ForeshadowingBoardView {
  return {
    columns: { planted: [], hinted: [], developed: [], revealed: [], resolved: [], abandoned: [] },
    issues: [],
  }
}

/** 手动放行的异步结果：制造「请求已发出、尚未返回」的中间态 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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

/** 直接种一条恢复镜像记录（模拟刷新前的 IndexedDB 内容） */
function seedRecord(
  projectId: string,
  cardId: string,
  entry: {
    draft?: Record<string, string | null>
    baseContentHash?: string
    abandon?: { reason: string; afterId: string | null; beforeId: string | null }
  },
): void {
  const key = buildCardDraftKey(projectId, cardId)
  memoryStore.records.set(key, {
    key,
    projectId,
    cardId,
    draft: entry.draft ?? { name: null, readerView: null, authorTruth: null, status: null },
    ...(entry.baseContentHash !== undefined ? { baseContentHash: entry.baseContentHash } : {}),
    mode: 'edit',
    ...(entry.abandon !== undefined ? { abandon: { ...entry.abandon } } : {}),
    updatedAt: '2026-11-20T10:00:00.000Z',
  })
}

/** 打开伏笔卡并开启自动保存（生产由 ProjectView 挂载时打开）的通用前置 */
async function openCardWithAutosave() {
  vi.useFakeTimers()
  const store = useForeshadowingStore()
  store.setCardAutosaveEnabled(true)
  readForeshadowing.mockResolvedValue(view())
  getForeshadowingBoard.mockResolvedValue(emptyBoard())
  await store.openCard(PROJECT, 'f1')
  return store
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

describe('伏笔主动放弃（阶段 4：原因操作态与原子提交）', () => {
  it('详情进入操作态：不登记状态、无两秒计时器；空原因不能确认；确认后原子提交且不带落点', async () => {
    const store = await openCardWithAutosave()

    expect(store.startAbandon(PROJECT)).toBe(true)
    expect(store.abandonIntent).toEqual({ reason: '' })
    // 进入操作态不登记状态（不走两秒延迟保存），也不产生自动放弃的计时器
    expect(store.draftStatus).toBeNull()
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 空原因（含纯空白）：确认防御，不触发请求
    store.updateAbandonReason(PROJECT, '   ')
    expect(await store.confirmAbandonCard(PROJECT)).toBe(false)
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 非空原因：一次调用提交「放弃状态 + 原因 + 基线 hash」；详情内进入不带落点字段
    const reason = '线索被第三章直接说明取代'
    store.updateAbandonReason(PROJECT, reason)
    updateForeshadowing.mockResolvedValue(view({ status: 'abandoned', abandonedReason: reason, contentHash: 'hash-f2' }))
    getForeshadowingBoard.mockClear()
    expect(await store.confirmAbandonCard(PROJECT)).toBe(true)
    expect(updateForeshadowing).toHaveBeenCalledTimes(1)
    const [calledProject, payload] = updateForeshadowing.mock.calls[0] as [string, Record<string, unknown>]
    expect(calledProject).toBe(PROJECT)
    expect(payload).toMatchObject({
      id: 'f1',
      status: 'abandoned',
      abandonedReason: reason,
      expectedContentHash: 'hash-f1',
    })
    expect('afterId' in payload).toBe(false)
    expect('beforeId' in payload).toBe(false)
    // 成功后：操作态退出、详情切已放弃并回预览、草稿清空、镜像清除、看板刷新
    expect(store.abandonIntent).toBeNull()
    expect(store.activeCard?.status).toBe('abandoned')
    expect(store.activeCard?.abandonedReason).toBe(reason)
    expect(store.draftReaderView).toBeNull()
    expect(store.detailMode).toBe('preview')
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'f1'))
    expect(getForeshadowingBoard).toHaveBeenCalledWith(PROJECT)
  })

  it('拖入已放弃列：操作态暂存落点（镜像携带），确认时随放弃一起提交', async () => {
    const store = await openCardWithAutosave()

    expect(store.startAbandon(PROJECT, { afterId: 'f9', beforeId: null })).toBe(true)
    store.updateAbandonReason(PROJECT, '节奏拖沓')
    // 操作态随镜像持久化（含拖入落点）
    vi.advanceTimersByTime(800)
    await drainBackupWrites()
    expect(memoryStore.records.get(buildCardDraftKey(PROJECT, 'f1'))?.abandon).toEqual({
      reason: '节奏拖沓',
      afterId: 'f9',
      beforeId: null,
    })

    updateForeshadowing.mockResolvedValue(view({ status: 'abandoned', contentHash: 'hash-f2' }))
    expect(await store.confirmAbandonCard(PROJECT)).toBe(true)
    expect(updateForeshadowing).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ status: 'abandoned', abandonedReason: '节奏拖沓', afterId: 'f9' }),
    )
    // afterId 有值时不携带 beforeId 字段（服务层落点二选一）
    const payload = updateForeshadowing.mock.calls[0][1] as Record<string, unknown>
    expect('beforeId' in payload).toBe(false)
  })

  it('字段修改在途时进入操作态：操作区立即可见、确认禁用，收口完成后才可确认', async () => {
    const store = await openCardWithAutosave()
    store.updateDraftReaderView('补写的读者视角')

    // 进入操作态触发在途内容立即收口；把写盘挂起制造「正在保存」
    const pending = deferred<ForeshadowingCardView>()
    updateForeshadowing.mockReturnValueOnce(pending.promise)
    expect(store.startAbandon(PROJECT)).toBe(true)
    expect(store.abandonIntent).toEqual({ reason: '' })
    await drainBackupWrites()
    expect(store.savePhase).toBe('saving')
    expect(store.canConfirmAbandon).toBe(false)
    expect(updateForeshadowing).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ id: 'f1', readerView: '补写的读者视角' }),
    )

    // 收口完成：以最新卡片版本进入放弃确认
    pending.resolve(view({ readerBody: '补写的读者视角', contentHash: 'hash-f2' }))
    await drainBackupWrites()
    expect(store.savePhase).toBe('clean')
    expect(store.canConfirmAbandon).toBe(true)
  })

  it('确认失败：原因保留可重试；外部修改冲突冻结确认，原因不丢', async () => {
    const store = await openCardWithAutosave()
    store.startAbandon(PROJECT)
    store.updateAbandonReason(PROJECT, '节奏拖沓')

    // 普通失败：原状态不动、原因与操作态保留
    updateForeshadowing.mockRejectedValueOnce(new Error('磁盘写坏'))
    expect(await store.confirmAbandonCard(PROJECT)).toBe(false)
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
    expect(store.actionError).not.toBe('')
    expect(store.canConfirmAbandon).toBe(true)

    // 版本冲突：建立冲突（先处理版本关系），确认冻结、原因保留
    readForeshadowing.mockResolvedValue(view({ readerBody: '外部改的视角', contentHash: 'hash-x' }))
    updateForeshadowing.mockRejectedValueOnce(
      new ForeshadowingConflictError('伏笔文件已被外部修改', conflictCard({ readerBody: '外部改的视角', contentHash: 'hash-x' })),
    )
    expect(await store.confirmAbandonCard(PROJECT)).toBe(false)
    await drainBackupWrites()
    expect(store.savePhase).toBe('conflict')
    expect(store.canConfirmAbandon).toBe(false)
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
    expect(store.conflictView).not.toBeNull()
  })

  it('取消：退出操作态、草稿干净时清镜像；已填原因暂存会话，再次进入时回填', async () => {
    const store = await openCardWithAutosave()

    store.startAbandon(PROJECT)
    store.updateAbandonReason(PROJECT, '节奏拖沓')
    vi.advanceTimersByTime(800)
    await drainBackupWrites()
    expect(memoryStore.records.get(buildCardDraftKey(PROJECT, 'f1'))?.abandon?.reason).toBe('节奏拖沓')

    // 取消：只退出操作态，不写盘；草稿干净 → 恢复镜像一并清除
    store.cancelAbandon(PROJECT)
    await drainBackupWrites()
    expect(store.abandonIntent).toBeNull()
    expect(memoryStore.deletedKeys).toContain(buildCardDraftKey(PROJECT, 'f1'))
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 再次进入：原因回填，便于继续填写
    expect(store.startAbandon(PROJECT)).toBe(true)
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
  })

  it('刷新恢复操作态：草稿已落盘也保留会话（keepAlive）并收敛 clean，仍待用户明确确认', async () => {
    vi.useFakeTimers()
    const store = useForeshadowingStore()
    store.setCardAutosaveEnabled(true)
    readForeshadowing.mockResolvedValue(view())
    getForeshadowingBoard.mockResolvedValue(emptyBoard())
    // 恢复镜像：草稿内容已与磁盘一致（此前收口已落盘）+ 待确认放弃操作态（含落点）
    seedRecord(PROJECT, 'f1', {
      draft: { name: null, readerView: '读者看到的', authorTruth: null, status: null },
      baseContentHash: 'hash-f1',
      abandon: { reason: '节奏拖沓', afterId: 'f9', beforeId: null },
    })

    const report = await store.restoreCardDrafts(PROJECT)
    // keepAlive：内容已落盘也不做冗余清理，会话保留供操作态回填
    expect(report.restored.map(entry => entry.key)).toEqual(['f1'])
    expect(report.discarded).toEqual([])
    await drainBackupWrites()

    await store.openCard(PROJECT, 'f1')
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
    expect(store.savePhase).toBe('clean')
    expect(store.canConfirmAbandon).toBe(true)

    // 恢复后绝不自动放弃（操作态不触发自动保存，收敛后也无待写内容）
    vi.advanceTimersByTime(2000)
    await drainBackupWrites()
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 用户再次明确确认：带暂存落点原子提交
    updateForeshadowing.mockResolvedValue(view({ status: 'abandoned', contentHash: 'hash-f2' }))
    expect(await store.confirmAbandonCard(PROJECT)).toBe(true)
    expect(updateForeshadowing).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        status: 'abandoned',
        abandonedReason: '节奏拖沓',
        afterId: 'f9',
        expectedContentHash: 'hash-f1',
      }),
    )
  })

  it('恢复操作态遇外部修改：操作态与冲突并存，确认冻结待版本出口处理', async () => {
    const store = useForeshadowingStore()
    readForeshadowing.mockResolvedValue(view({ readerBody: '外部改的', contentHash: 'hash-x' }))
    getForeshadowingBoard.mockResolvedValue(emptyBoard())
    seedRecord(PROJECT, 'f1', {
      draft: { name: null, readerView: '我的草稿', authorTruth: null, status: null },
      baseContentHash: 'hash-f1',
      abandon: { reason: '节奏拖沓', afterId: null, beforeId: null },
    })

    const report = await store.restoreCardDrafts(PROJECT)
    expect(report.conflicted).toEqual([{ key: 'f1' }])
    await store.openCard(PROJECT, 'f1')
    // 原因保留在操作态里，但确认冻结：先处理版本关系
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
    expect(store.savePhase).toBe('conflict')
    expect(store.canConfirmAbandon).toBe(false)
  })

  it('冲突中采用磁盘版本：原因不丢，版本重置后以新基线继续确认', async () => {
    const store = await openCardWithAutosave()
    store.startAbandon(PROJECT)
    store.updateAbandonReason(PROJECT, '节奏拖沓')

    // 确认撞外部修改冲突：冻结建冲突
    readForeshadowing.mockResolvedValue(view({ readerBody: '外部改的视角', contentHash: 'hash-x' }))
    updateForeshadowing.mockRejectedValueOnce(
      new ForeshadowingConflictError('伏笔文件已被外部修改', conflictCard({ contentHash: 'hash-x' })),
    )
    expect(await store.confirmAbandonCard(PROJECT)).toBe(false)
    await drainBackupWrites()
    expect(store.conflictView).not.toBeNull()

    // 采用磁盘版本（详情重开为外部内容）：任何采用磁盘都不能顺带清除原因
    expect(await store.adoptDiskVersion(PROJECT)).toBe(true)
    await drainBackupWrites()
    expect(store.conflictView).toBeNull()
    expect(store.abandonIntent).toEqual({ reason: '节奏拖沓' })
    expect(store.canConfirmAbandon).toBe(true)

    // 以新基线确认成功
    updateForeshadowing.mockResolvedValue(view({ status: 'abandoned', contentHash: 'hash-f3' }))
    expect(await store.confirmAbandonCard(PROJECT)).toBe(true)
    expect(updateForeshadowing).toHaveBeenLastCalledWith(
      PROJECT,
      expect.objectContaining({ status: 'abandoned', abandonedReason: '节奏拖沓', expectedContentHash: 'hash-x' }),
    )
  })
})
