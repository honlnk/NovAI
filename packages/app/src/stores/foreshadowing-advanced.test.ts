/**
 * 伏笔高级信息（作者字段控制权计划阶段 2）事件链测试：
 * - 高级字段草稿统一保存：只提交实际变更字段、携带读取时 hash；
 * - 非法窗口（起点未设置而终点有值）只阻止本次写入并显示字段错误，不清草稿；
 * - 回收窗口两套数据不一致：三出口按明确操作提交（结构化/兼容各自的重写语义）；
 * - 已放弃卡的历史原因修订：操作态→空值拒 Confirm→应用携带 hash 提交→镜像收口；
 * - 刷新恢复：带修订操作态的镜像 keepAlive，恢复后仍待明确确认。
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

function view(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCardView {
  return {
    id: 'f1',
    name: '茶馆暗号',
    status: 'planted',
    order: 0,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    plantedAt: '第一卷/第005章',
    payoffStart: null,
    payoffEnd: null,
    payoffWindow: ['第一卷/第010章', '第一卷/第020章'] as [string, string],
    isRedHerring: false,
    relatedChapters: ['第一卷/第006章'],
    relatedCharacters: ['林掌柜'],
    relatedEntities: ['茶馆'],
    resolvedAt: null,
    abandonedReason: null,
    readerBody: '读者看到的',
    authorTruth: '作者知道的',
    summary: '读者看到的',
    sourcePath: 'foreshadowing/茶馆暗号.md',
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

/** 打开伏笔卡并开启自动保存（生产由 ProjectView 挂载时打开）的通用前置 */
async function openCardWithAutosave(card: ForeshadowingCardView = view()) {
  vi.useFakeTimers()
  const store = useForeshadowingStore()
  store.setCardAutosaveEnabled(true)
  readForeshadowing.mockResolvedValue(card)
  getForeshadowingBoard.mockResolvedValue(emptyBoard())
  await store.openCard(PROJECT, 'f1')
  updateForeshadowing.mockClear()
  return store
}

/** 走完两秒去抖与写盘 promise 链 */
async function settleSave(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2500)
}

/** 直接种一条恢复镜像记录（模拟刷新前的 IndexedDB 内容） */
function seedRecord(
  projectId: string,
  cardId: string,
  entry: {
    draft?: Record<string, string | number | null>
    baseContentHash?: string
    reasonRevision?: { reason: string }
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
    ...(entry.reasonRevision !== undefined ? { reasonRevision: { ...entry.reasonRevision } } : {}),
    updatedAt: '2026-11-20T10:00:00.000Z',
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

describe('伏笔高级信息（阶段 2：统一草稿与字段级提交）', () => {
  it('高级字段进入同一份草稿：只提交实际变更字段并携带读取时 hash', async () => {
    const store = await openCardWithAutosave()

    store.updateDraftPlantedAt('第一卷/第008章')
    store.updateDraftPayoffStart('relative:15:12:3')
    store.updateDraftPayoffEnd('open')
    store.updateDraftRelatedCharactersText('林掌柜、阿四，林掌柜')
    store.updateDraftRelatedChapters(['第一卷/第006章', '第一卷/第007章'])
    store.updateDraftIsRedHerring(true)
    store.updateDraftResolvedAt('第一卷/第009章')

    updateForeshadowing.mockResolvedValue(view())
    await settleSave()

    expect(updateForeshadowing).toHaveBeenCalledTimes(1)
    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.id).toBe('f1')
    expect(payload.plantedAt).toBe('第一卷/第008章')
    expect(payload.payoffStart).toEqual({ kind: 'relative', target: 15, base: 12, offset: 3 })
    expect(payload.payoffEnd).toEqual({ kind: 'open' })
    // 标签输入去空白去重（首现位置）
    expect(payload.relatedCharacters).toEqual(['林掌柜', '阿四'])
    expect(payload.relatedChapters).toEqual(['第一卷/第006章', '第一卷/第007章'])
    expect(payload.isRedHerring).toBe(true)
    expect(payload.resolvedAt).toBe('第一卷/第009章')
    // 未修改的正文三件不在提交里
    expect(payload.name).toBeUndefined()
    expect(payload.readerView).toBeUndefined()
    expect(payload.authorTruth).toBeUndefined()
    expect(payload.expectedContentHash).toBe('hash-f1')
  })

  it('只改一个高级字段（如红鲱鱼）不携带其他字段；实际回收清除传 null', async () => {
    const store = await openCardWithAutosave(view({ resolvedAt: '第一卷/第009章', isRedHerring: false }))

    store.updateDraftIsRedHerring(true)
    updateForeshadowing.mockResolvedValue(view({ isRedHerring: true, resolvedAt: '第一卷/第009章' }))
    await settleSave()

    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.isRedHerring).toBe(true)
    expect(payload.payoffStart).toBeUndefined()
    expect(payload.plantedAt).toBeUndefined()

    store.updateDraftResolvedAt('')
    updateForeshadowing.mockResolvedValue(view({ isRedHerring: true }))
    await settleSave()
    const clearPayload = updateForeshadowing.mock.calls[1]![1] as Record<string, unknown>
    expect(clearPayload.resolvedAt).toBeNull()
  })

  it('非法窗口（起点未设置而终点有值）只阻止本次写入并显示字段错误；输入与草稿保留', async () => {
    const store = await openCardWithAutosave()

    store.updateDraftPayoffStart('none')
    // 面板层清空起点会把终点一并清为 none；这里直接构造非法组合（防御外部写入）
    store.updateDraftPayoffEnd('future:20')

    await settleSave()

    expect(updateForeshadowing).not.toHaveBeenCalled()
    expect(store.savePhase).toBe('failed')
    expect(store.actionError).toContain('起点')
    // 草稿保留，修正后可保存
    store.updateDraftPayoffStart('future:15')
    updateForeshadowing.mockResolvedValue(view())
    await settleSave()
    expect(updateForeshadowing).toHaveBeenCalledTimes(1)
    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.payoffStart).toEqual({ kind: 'future', target: 15 })
    expect(payload.payoffEnd).toEqual({ kind: 'future', target: 20 })
  })

  it('清空起点时终点一并清空：整窗落盘为未设置（结构化 + 旧字段同一次写）', async () => {
    const store = await openCardWithAutosave()

    store.updateDraftPayoffStart('none')
    updateForeshadowing.mockResolvedValue(view())
    await settleSave()

    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.payoffStart).toEqual({ kind: 'none' })
    expect(payload.payoffEnd).toEqual({ kind: 'none' })
  })
})

describe('回收窗口两套数据不一致（阶段 2：三出口明确操作）', () => {
  function mismatchedCard(): ForeshadowingCardView {
    return view({
      payoffStart: { kind: 'future', target: 15 },
      payoffEnd: { kind: 'open' },
      payoffWindow: ['第020章', '开放终点'],
    })
  }

  it('不一致检测：结构化与旧字段冲突时 windowMismatch 为真并并列展示', async () => {
    const store = await openCardWithAutosave(mismatchedCard())

    expect(store.windowMismatch).toBe(true)
    expect(store.windowMismatchViews).toEqual({
      structured: '第15章 ~ 开放终点',
      legacy: '第020章 ~ 开放终点',
    })

    // 一致的卡不算不一致
    await store.openCard(PROJECT, 'f1')
    readForeshadowing.mockResolvedValue(view())
    await store.openCard(PROJECT, 'f1')
    expect(store.windowMismatch).toBe(false)
  })

  it('采用结构化：按结构化值重写旧字段（提交两侧结构化位置 + hash）', async () => {
    const store = await openCardWithAutosave(mismatchedCard())

    updateForeshadowing.mockResolvedValue(mismatchedCard())
    const ok = await store.adoptWindowResolution(PROJECT, 'structured')
    expect(ok).toBe(true)
    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.payoffStart).toEqual({ kind: 'future', target: 15 })
    expect(payload.payoffEnd).toEqual({ kind: 'open' })
    expect(payload.expectedContentHash).toBe('hash-f1')
  })

  it('采用兼容：旧窗口解释为固定章号位置/开放终点并重写结构化', async () => {
    const store = await openCardWithAutosave(mismatchedCard())

    updateForeshadowing.mockResolvedValue(mismatchedCard())
    const ok = await store.adoptWindowResolution(PROJECT, 'legacy')
    expect(ok).toBe(true)
    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.payoffStart).toEqual({ kind: 'chapter', ref: '第020章' })
    expect(payload.payoffEnd).toEqual({ kind: 'open' })
  })

  it('字段未收口（clean 前）不执行；外部修改冲突转冻结', async () => {
    const store = await openCardWithAutosave(mismatchedCard())

    store.updateDraftReaderView('在途修改')
    await expect(store.adoptWindowResolution(PROJECT, 'structured')).resolves.toBe(false)
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 收口后再试：外部先改盘 + 冲突错误 → 冻结转冲突流程（savePhase 变 conflict）
    updateForeshadowing.mockResolvedValueOnce(view())
    await settleSave()
    expect(store.savePhase).toBe('clean')

    readForeshadowing.mockResolvedValue(view({ contentHash: 'hash-external', name: '外部改名' }))
    updateForeshadowing.mockRejectedValueOnce(new ForeshadowingConflictError(
      '版本冲突',
      { ...view(), body: 'x' } as unknown as ForeshadowingCard,
    ))
    await expect(store.adoptWindowResolution(PROJECT, 'structured')).resolves.toBe(false)
    // 干净会话不建引擎冲突：改为重读磁盘展示最新两套数据，明确提示后重试
    expect(store.actionError).toContain('外部修改')
    expect(readForeshadowing).toHaveBeenCalledWith(PROJECT, 'f1')
  })
})

describe('已放弃卡的历史原因修订（阶段 2：明确操作）', () => {
  function abandonedCard(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCardView {
    return view({ status: 'abandoned', abandonedReason: '旧原因', ...overrides })
  }

  it('进入操作态不触发两秒保存；空原因不能应用；应用提交原因与 hash 且成功收口', async () => {
    const store = await openCardWithAutosave(abandonedCard())

    expect(store.startReasonRevision(PROJECT)).toBe(true)
    expect(store.reasonRevisionIntent).toEqual({ reason: '' })

    // 空原因：应用被拦（不调用服务）
    await expect(store.confirmReasonRevision(PROJECT)).resolves.toBe(false)
    expect(updateForeshadowing).not.toHaveBeenCalled()

    store.updateReasonRevision(PROJECT, '  修订后的原因  ')
    updateForeshadowing.mockResolvedValue(abandonedCard({ abandonedReason: '修订后的原因' }))
    await expect(store.confirmReasonRevision(PROJECT)).resolves.toBe(true)

    expect(updateForeshadowing).toHaveBeenCalledTimes(1)
    const payload = updateForeshadowing.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.abandonedReason).toBe('修订后的原因')
    expect(payload.status).toBeUndefined()
    expect(payload.expectedContentHash).toBe('hash-f1')

    // 成功后操作态收口
    expect(store.reasonRevisionIntent).toBeNull()
  })

  it('取消退出操作态：原因暂存再次进入回填；应用失败保留操作态与输入', async () => {
    const store = await openCardWithAutosave(abandonedCard())

    store.startReasonRevision(PROJECT)
    store.updateReasonRevision(PROJECT, '写了一半的原因')
    store.cancelReasonRevision(PROJECT)
    expect(store.reasonRevisionIntent).toBeNull()

    // 再次进入：暂存文本回填
    store.startReasonRevision(PROJECT)
    expect(store.reasonRevisionIntent).toEqual({ reason: '写了一半的原因' })

    // 应用失败：原原因不动、输入保留
    updateForeshadowing.mockRejectedValueOnce(new Error('网络失败'))
    await expect(store.confirmReasonRevision(PROJECT)).resolves.toBe(false)
    expect(store.reasonRevisionIntent).toEqual({ reason: '写了一半的原因' })
    expect(store.actionError).toContain('网络失败')
  })

  it('刷新恢复：带修订操作态的镜像 keepAlive，恢复后仍待明确确认不自动写盘', async () => {
    vi.useFakeTimers()
    seedRecord(PROJECT, 'f1', {
      draft: { name: null, readerView: null, authorTruth: null, status: null },
      baseContentHash: 'hash-f1',
      reasonRevision: { reason: '刷新前填写的原因' },
    })
    const store = useForeshadowingStore()
    readForeshadowing.mockResolvedValue(abandonedCard())
    getForeshadowingBoard.mockResolvedValue(emptyBoard())
    await store.restoreCardDrafts(PROJECT)

    // 恢复后不自动应用
    await vi.advanceTimersByTimeAsync(3000)
    expect(updateForeshadowing).not.toHaveBeenCalled()

    // 打开卡片后操作态在场，确认可正常应用
    store.setCardAutosaveEnabled(true)
    await store.openCard(PROJECT, 'f1')
    expect(store.reasonRevisionIntent).toEqual({ reason: '刷新前填写的原因' })
    updateForeshadowing.mockResolvedValue(abandonedCard({ abandonedReason: '刷新前填写的原因' }))
    await expect(store.confirmReasonRevision(PROJECT)).resolves.toBe(true)
    expect(updateForeshadowing).toHaveBeenCalledTimes(1)
  })
})
