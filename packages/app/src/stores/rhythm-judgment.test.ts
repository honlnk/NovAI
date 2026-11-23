/**
 * 节奏判定操作态（作者字段控制权计划阶段 4）事件链测试：
 * - 作者校正：进入/更新/取消（暂存回填）；应用是显式保存——表单结论与同轮
 *   未落盘草稿合并为一次整体提交（§五.2.2），空草稿也能应用（「无待写内容」
 *   短路不拦显式操作），成功后操作态与草稿一并收口；
 * - 失败保留全部输入且不自动补试（明确操作由用户重试；避免无载荷落盘字段）；
 * - 恢复自动：两步确认（预演对照 → 确认一次保存 restoreAutoJudgment），与
 *   校正操作态互斥（切换时暂存，不丢输入）；
 * - 待确认操作态进恢复镜像：刷新后回填仍待确认、绝不自动执行；外部修改到达
 *   时干净会话也建冲突（确认冻结）；
 * - 比较值保存前警告（作者卡改比较值 → 提示将恢复自动）与恢复自动预演的
 *   合并口径（磁盘卡 + 草稿覆盖，清除哨兵参与）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { RhythmBoardView, RhythmCardSummaryView, RhythmCardView } from '@novai/core/services/types'
import { RhythmError } from '@novai/core/types/rhythm'

import { useRhythmStore } from './rhythm'
import {
  _resetCardBackupForTest,
  _setCardBackupStoreForTest,
  type CardBackupStore,
  type PersistedCardDraftRecord,
} from '../composables/card-backup'

const { getRhythmBoard, readRhythm, updateRhythm, readRhythmDeviationThreshold } = vi.hoisted(() => ({
  getRhythmBoard: vi.fn(),
  readRhythm: vi.fn(),
  updateRhythm: vi.fn(),
  readRhythmDeviationThreshold: vi.fn(),
}))

vi.mock('@novai/core/services/rhythm-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@novai/core/services/rhythm-service')>(),
  getRhythmBoard,
  readRhythm,
  updateRhythm,
  readRhythmDeviationThreshold,
}))

const PROJECT = 'p-1'

function view(overrides: Partial<RhythmCardView> = {}): RhythmCardView {
  return {
    id: 'r1',
    name: '第083章节奏',
    status: 'planned',
    order: 0,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    chapterRef: '第083章',
    plannedConflict: 5,
    plannedMood: '紧张',
    plannedHook: '悬念',
    plannedPayoff: '揭秘',
    actualConflict: null,
    actualMood: null,
    actualHook: null,
    actualPayoff: null,
    deviationFlag: false,
    judgmentSource: 'auto',
    thresholdPending: false,
    summary: '',
    sourcePath: 'rhythm/r1.md',
    plannedCharacters: ['林远'],
    plannedNote: null,
    actualNote: null,
    deviationNote: null,
    authorDeviationNote: null,
    lastJudgmentThreshold: null,
    intentBody: '本章要绷紧。',
    linkBody: '',
    authorNoteBody: '',
    contentHash: 'hash-r1',
    ...overrides,
  }
}

/** 已回写的作者校正卡（恢复自动入口的典型现场） */
function authorCard(overrides: Partial<RhythmCardView> = {}): RhythmCardView {
  return view({
    status: 'written',
    actualConflict: 7,
    actualMood: '悲壮',
    actualHook: '悬念',
    actualPayoff: '揭秘',
    deviationFlag: false,
    judgmentSource: 'author',
    authorDeviationNote: null,
    lastJudgmentThreshold: 3,
    ...overrides,
  })
}

function emptyBoard(): RhythmBoardView {
  return { columns: { planned: [], written: [], deviated: [] }, issues: [] }
}

type MemoryCardStore = CardBackupStore & {
  records: Map<string, PersistedCardDraftRecord>
}

function createMemoryCardStore(): MemoryCardStore {
  const records = new Map<string, PersistedCardDraftRecord>()
  return {
    records,
    async put(record) {
      records.set(record.key, { ...record })
    },
    async delete(key) {
      records.delete(key)
    },
    async listByProject(projectId) {
      return [...records.values()].filter(record => record.projectId === projectId)
    },
  }
}

let memoryStore: MemoryCardStore

/** 打开节奏卡（自动保存常开，与生产一致）的通用前置 */
async function openCard(card: RhythmCardView = view()) {
  vi.useFakeTimers()
  const store = useRhythmStore()
  store.setCardAutosaveEnabled(true)
  readRhythm.mockResolvedValue(card)
  getRhythmBoard.mockResolvedValue(emptyBoard())
  readRhythmDeviationThreshold.mockReturnValue(3)
  await store.openCard(PROJECT, 'r1')
  updateRhythm.mockClear()
  getRhythmBoard.mockClear()
  return store
}

/** 走完 800ms 镜像去抖，把待写记录落进内存备份存储 */
async function settleMirror(): Promise<void> {
  await vi.advanceTimersByTimeAsync(900)
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

describe('作者校正操作态（阶段 4 §五.2）', () => {
  it('进入操作态：表单默认为当前有效结论；输入只更新操作态并进镜像', async () => {
    const card = authorCard({ status: 'deviated', deviationFlag: true, authorDeviationNote: '刻意升温' })
    const store = await openCard(card)

    expect(store.authorCorrectionIntent).toBeNull()
    expect(store.startAuthorCorrection(PROJECT)).toBe(true)

    const intent = store.authorCorrectionIntent
    expect(intent).toEqual({ status: 'deviated', deviationFlag: true, deviationNote: '刻意升温' })

    store.updateAuthorCorrection(PROJECT, { deviationNote: '刻意升温，别动' })
    expect(store.authorCorrectionIntent?.deviationNote).toBe('刻意升温，别动')
    await settleMirror()

    const record = memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))
    expect(record?.authorCorrection).toEqual({ status: 'deviated', deviationFlag: true, deviationNote: '刻意升温，别动' })
    // 操作态不触发自动保存
    expect(updateRhythm).not.toHaveBeenCalled()
  })

  it('取消校正：表单暂存，再次进入回填；干净会话取消后镜像清除', async () => {
    const store = await openCard(authorCard())

    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '节奏走样说明' })
    store.cancelAuthorCorrection(PROJECT)
    expect(store.authorCorrectionIntent).toBeNull()
    await settleMirror()
    expect(memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))).toBeUndefined()

    store.startAuthorCorrection(PROJECT)
    expect(store.authorCorrectionIntent).toEqual({ status: 'written', deviationFlag: true, deviationNote: '节奏走样说明' })
  })

  it('应用校正：表单结论与同轮未落盘草稿合并为一次整体保存（§五.2.2）', async () => {
    const card = authorCard()
    const store = await openCard(card)

    store.updateDraft({ actualConflict: 9, intentBody: '改过的意图。' })
    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { status: 'deviated', deviationFlag: true, deviationNote: '刻意升温，别动' })

    updateRhythm.mockResolvedValue(authorCard({
      status: 'deviated',
      deviationFlag: true,
      authorDeviationNote: '刻意升温，别动',
      actualConflict: 9,
      intentBody: '改过的意图。',
      contentHash: 'hash-r2',
    }))
    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)

    // 一次调用同时携带草稿增量与判定载荷；不等待两秒计时
    expect(updateRhythm).toHaveBeenCalledTimes(1)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.actualConflict).toBe(9)
    expect(payload.intentBody).toBe('改过的意图。')
    expect(payload.authorJudgment).toEqual({ status: 'deviated', deviationFlag: true, deviationNote: '刻意升温，别动' })
    expect(payload.expectedContentHash).toBe('hash-r1')

    // 成功收口：操作态清空、草稿收敛（无未保存修改）、看板刷新、镜像清除
    expect(store.authorCorrectionIntent).toBeNull()
    expect(store.draft).toBeNull()
    expect(getRhythmBoard).toHaveBeenCalledTimes(1)
    await settleMirror()
    expect(memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))).toBeUndefined()
  })

  it('空草稿也能应用：显式保存不受「无待写内容」短路（差异在操作载荷里）', async () => {
    const store = await openCard(authorCard())

    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '按作者口径算偏差' })
    updateRhythm.mockResolvedValue(authorCard({ status: 'deviated', deviationFlag: true, authorDeviationNote: '按作者口径算偏差', contentHash: 'hash-r2' }))

    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)
    expect(updateRhythm).toHaveBeenCalledTimes(1)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.authorJudgment).toEqual({ status: 'written', deviationFlag: true, deviationNote: '按作者口径算偏差' })
    expect(payload.expectedContentHash).toBe('hash-r1')
  })

  it('应用失败：保留表单与草稿；后续自动保存不再携带判定载荷，再次应用可成功', async () => {
    const store = await openCard(authorCard())
    updateRhythm.mockResolvedValue(authorCard({ contentHash: 'hash-r2' }))

    store.updateDraft({ actualConflict: 9 })
    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '走样说明' })

    updateRhythm.mockRejectedValueOnce(new RhythmError('网络写入失败'))
    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(false)
    expect(updateRhythm).toHaveBeenCalledTimes(1)
    expect((updateRhythm.mock.calls[0]![1] as Record<string, unknown>).authorJudgment).toBeDefined()
    expect(store.authorCorrectionIntent?.deviationNote).toBe('走样说明')
    expect(store.draftActualConflict).toBe(9)

    // 显式失败不自动补试；草稿的两秒自动保存照常进行（作者改比较值保存后按
    // 规则回到自动重算），但判定载荷已一次性消费——自动保存不得再携带
    await vi.advanceTimersByTimeAsync(6000)
    const calls = updateRhythm.mock.calls.map(call => call[1] as Record<string, unknown>)
    expect(calls.length).toBe(2)
    expect(calls[1]!.authorJudgment).toBeUndefined()
    expect(store.authorCorrectionIntent).not.toBeNull()

    // 用户再次明确应用：新一次显式保存重新携带判定载荷并可成功
    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)
    const retry = updateRhythm.mock.calls[calls.length]![1] as Record<string, unknown>
    expect(retry.authorJudgment).toBeDefined()
    expect(store.authorCorrectionIntent).toBeNull()
  })

  it('有偏差缺说明：应用前就地拦截，不发起写盘', async () => {
    const store = await openCard(authorCard())

    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '   ' })

    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(false)
    expect(updateRhythm).not.toHaveBeenCalled()
    expect(store.actionError).toContain('偏差说明')
  })
})

describe('恢复自动判定（阶段 4 §五.3）', () => {
  it('两步确认：进入确认态展示预演；确认一次保存 restoreAutoJudgment 与草稿增量', async () => {
    const card = authorCard({ authorDeviationNote: '先压着，后续再说' })
    const store = await openCard(card)

    store.updateDraft({ plannedNote: '作者补充的计划备注' })
    expect(store.startRestoreAuto(PROJECT)).toBe(true)
    expect(store.isRestoreAutoPending).toBe(true)

    // 预演按合并值与当前阈值：冲突 |5-7|=2 < 3 不算，但情绪 紧张→悲壮 不一致
    // → 偏差 · 有偏差（作者结论是已写 · 无偏差，恢复后将回到自动结论）
    expect(store.restoreAutoPreview).toEqual({
      status: 'deviated',
      deviationFlag: true,
      deviationNote: '情绪基调偏差：计划 紧张 实际 悲壮',
    })

    updateRhythm.mockResolvedValue(authorCard({ judgmentSource: 'auto', authorDeviationNote: '先压着，后续再说', plannedNote: '作者补充的计划备注', contentHash: 'hash-r2' }))
    await expect(store.confirmRestoreAuto(PROJECT)).resolves.toBe(true)

    expect(updateRhythm).toHaveBeenCalledTimes(1)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.restoreAutoJudgment).toBe(true)
    expect(payload.plannedNote).toBe('作者补充的计划备注')
    expect(payload.authorJudgment).toBeUndefined()
    expect(store.isRestoreAutoPending).toBe(false)
  })

  it('预演合并草稿与清除哨兵：actualConflict 草稿清成未填写 → 回到规划中', async () => {
    const store = await openCard(authorCard())

    store.updateDraft({ actualConflict: 0, actualMood: '', actualHook: '', actualPayoff: '' })
    store.startRestoreAuto(PROJECT)
    expect(store.restoreAutoPreview).toEqual({ status: 'planned', deviationFlag: false, deviationNote: null })
    store.cancelRestoreAuto(PROJECT)
    expect(store.isRestoreAutoPending).toBe(false)
  })

  it('与作者校正互斥：进入恢复自动时未应用的校正表单按取消暂存', async () => {
    const store = await openCard(authorCard())

    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '临时说明' })
    store.startRestoreAuto(PROJECT)

    expect(store.authorCorrectionIntent).toBeNull()
    expect(store.isRestoreAutoPending).toBe(true)
    store.cancelRestoreAuto(PROJECT)

    store.startAuthorCorrection(PROJECT)
    expect(store.authorCorrectionIntent).toEqual({ status: 'written', deviationFlag: true, deviationNote: '临时说明' })
  })
})

describe('比较值保存前警告与阈值提示（阶段 4 §五.3）', () => {
  it('作者卡修改比较值触发警告；非比较字段与自动卡不触发', async () => {
    const store = await openCard(authorCard())

    expect(store.comparisonEditWarning).toBe(false)
    store.updateDraft({ intentBody: '改正文不算比较值' })
    expect(store.comparisonEditWarning).toBe(false)

    store.updateDraft({ actualConflict: 6 })
    expect(store.comparisonEditWarning).toBe(true)

    store.updateDraft({ actualConflict: null })
    expect(store.comparisonEditWarning).toBe(false)

    // 自动卡改比较值：保存后本来就会重算，不需要「将恢复自动」警告
    const autoStore = await openCard(view({ status: 'written', actualConflict: 5, actualMood: '紧张', actualHook: '悬念', actualPayoff: '揭秘' }))
    autoStore.updateDraft({ plannedConflict: 8 })
    expect(autoStore.comparisonEditWarning).toBe(false)
  })
})

describe('待确认操作态的镜像与冻结（阶段 4 §五.2.4）', () => {
  it('刷新恢复：待确认校正与恢复自动回填后仍待确认，绝不自动执行', async () => {
    const card = authorCard()
    const store = await openCard(card)
    store.startAuthorCorrection(PROJECT)
    store.updateAuthorCorrection(PROJECT, { deviationFlag: true, deviationNote: '待确认的说明' })
    await settleMirror()
    expect(memoryStore.records.size).toBe(1)

    // 模拟刷新：全新 pinia + store，按生产路径恢复镜像
    setActivePinia(createPinia())
    const store2 = useRhythmStore()
    store2.setCardAutosaveEnabled(true)
    readRhythm.mockResolvedValue(card)
    getRhythmBoard.mockResolvedValue(emptyBoard())
    await store2.restoreCardDrafts(PROJECT)
    await store2.openCard(PROJECT, 'r1')

    expect(store2.authorCorrectionIntent).toEqual({ status: 'written', deviationFlag: true, deviationNote: '待确认的说明' })
    // 恢复只回填待确认状态，不写盘
    expect(updateRhythm).not.toHaveBeenCalled()

    // 恢复自动操作态同样跨刷新保留
    store2.cancelAuthorCorrection(PROJECT)
    store2.startRestoreAuto(PROJECT)
    await settleMirror()
    setActivePinia(createPinia())
    const store3 = useRhythmStore()
    store3.setCardAutosaveEnabled(true)
    await store3.restoreCardDrafts(PROJECT)
    await store3.openCard(PROJECT, 'r1')
    expect(store3.isRestoreAutoPending).toBe(true)
    expect(updateRhythm).not.toHaveBeenCalled()
  })

  it('外部修改到达：干净草稿 + 待确认校正也建冲突，确认随之冻结', async () => {
    const card = authorCard()
    const store = await openCard(card)

    store.startAuthorCorrection(PROJECT)
    expect(store.canConfirmAuthorCorrection).toBe(true)

    readRhythm.mockResolvedValue(authorCard({ contentHash: 'hash-external' }))
    await store.freezeForExternalChange(PROJECT, 'r1')

    expect(store.savePhase).toBe('conflict')
    expect(store.canConfirmAuthorCorrection).toBe(false)
    // 操作态保留（冲突解决后继续处理）
    expect(store.authorCorrectionIntent).not.toBeNull()
  })
})

describe('跨列拖拽校正（阶段 5 §六）', () => {
  /** 带锚卡的看板（落点描述要引用锚卡名称） */
  function anchorBoard(): RhythmBoardView {
    const summary = (id: string, name: string): RhythmCardSummaryView => ({
      id,
      name,
      status: 'written',
      order: 100,
      createdAt: '',
      updatedAt: '',
      chapterRef: '第082章',
      plannedConflict: 5,
      plannedMood: '紧张',
      plannedHook: '悬念',
      plannedPayoff: '揭秘',
      actualConflict: 5,
      actualMood: '紧张',
      actualHook: '悬念',
      actualPayoff: '揭秘',
      deviationFlag: false,
      judgmentSource: 'auto',
      thresholdPending: false,
      summary: '',
      sourcePath: `rhythm/${id}.md`,
    })
    return {
      columns: { planned: [], written: [summary('r2', '第082章节奏')], deviated: [summary('r9', '第081章节奏')] },
      issues: [],
    }
  }

  it('跨列松手：打开详情进校正操作态——目标状态预选并联动偏差结论，落点暂存进镜像；应用前不写盘', async () => {
    const card = view({
      status: 'deviated',
      deviationFlag: true,
      actualConflict: 7,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
      deviationNote: '冲突强度偏高',
    })
    const store = await openCard(card)
    getRhythmBoard.mockResolvedValue(anchorBoard())
    await store.loadBoard(PROJECT)

    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    // 拖到「已写」= 目标状态预选 + 偏差结论联动为无偏差（与表单状态选择器同一联动）
    expect(store.authorCorrectionIntent).toEqual({ status: 'written', deviationFlag: false, deviationNote: '' })
    expect(store.correctionPlacementLabel).toBe('应用后将移动到「已写」列（「第082章节奏」之后）；取消或离开不动原位')

    await settleMirror()
    const record = memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))
    expect(record?.authorCorrection).toEqual({ status: 'written', deviationFlag: false, deviationNote: '' })
    expect(record?.pendingPlacement).toEqual({ status: 'written', afterId: 'r2' })
    // 应用前看板不动：不发起任何写盘
    expect(updateRhythm).not.toHaveBeenCalled()
  })

  it('应用校正：判定与落点一次保存（同一载荷携带 authorJudgment 与 afterId/beforeId）；成功后落点收口、看板刷新', async () => {
    const store = await openCard(authorCard({ status: 'deviated', deviationFlag: true }))

    // 列首落点：BoardPanel 对列首发出 afterId=null + beforeId=目标列首卡
    await store.crossMoveCard(PROJECT, 'r1', 'written', null, 'r2')
    updateRhythm.mockResolvedValue(authorCard({ status: 'written', contentHash: 'hash-r2' }))
    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)

    expect(updateRhythm).toHaveBeenCalledTimes(1)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.authorJudgment).toEqual({ status: 'written', deviationFlag: false })
    expect(payload.afterId).toBeNull()
    expect(payload.beforeId).toBe('r2')

    // 成功收口：操作态与落点一并清除、看板刷新、镜像清除
    expect(store.authorCorrectionIntent).toBeNull()
    expect(store.correctionPlacementLabel).toBeNull()
    expect(getRhythmBoard).toHaveBeenCalledTimes(1)
    await settleMirror()
    expect(memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))).toBeUndefined()
  })

  it('取消校正：落点一并丢弃（要移动重新拖），不写盘；再次进入回填表单但无落点', async () => {
    const store = await openCard(authorCard())

    await store.crossMoveCard(PROJECT, 'r1', 'deviated', 'r2')
    store.cancelAuthorCorrection(PROJECT)
    expect(store.authorCorrectionIntent).toBeNull()
    expect(store.correctionPlacementLabel).toBeNull()
    expect(updateRhythm).not.toHaveBeenCalled()
    await settleMirror()
    expect(memoryStore.records.get(JSON.stringify([PROJECT, 'r1']))).toBeUndefined()

    // 表单暂存回填（取消保留输入），落点不暂存
    store.startAuthorCorrection(PROJECT)
    expect(store.authorCorrectionIntent).not.toBeNull()
    expect(store.correctionPlacementLabel).toBeNull()
  })

  it('应用失败：落点与表单保留；重试成功后一并收口', async () => {
    const store = await openCard(authorCard())
    updateRhythm.mockResolvedValue(authorCard({ contentHash: 'hash-r2' }))

    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    updateRhythm.mockRejectedValueOnce(new RhythmError('网络写入失败'))
    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(false)
    expect(store.authorCorrectionIntent).not.toBeNull()
    expect(store.correctionPlacementLabel).not.toBeNull()

    await expect(store.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)
    const calls = updateRhythm.mock.calls.map(call => call[1] as Record<string, unknown>)
    expect(calls.every(payload => payload.afterId === 'r2' && payload.authorJudgment !== undefined)).toBe(true)
    expect(store.correctionPlacementLabel).toBeNull()
  })

  it('普通自动保存不携带落点：落点只在显式判定保存随行，自动保存后仍待确认', async () => {
    const store = await openCard(authorCard())
    updateRhythm.mockResolvedValue(authorCard({ contentHash: 'hash-r2' }))

    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    store.updateDraft({ intentBody: '同轮改的正文意图。' })

    // 两秒自动保存照常进行，但落点不随行（看板位置只由「应用校正」决定）
    await vi.advanceTimersByTimeAsync(6000)
    const autosave = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(autosave.intentBody).toBe('同轮改的正文意图。')
    expect(autosave.afterId).toBeUndefined()
    expect(autosave.authorJudgment).toBeUndefined()
    // 落点仍在会话里待确认
    expect(store.correctionPlacementLabel).not.toBeNull()
    expect(store.authorCorrectionIntent).not.toBeNull()
  })

  it('与恢复自动互斥：进入恢复自动时落点丢弃（移动属于校正操作的一部分）', async () => {
    const store = await openCard(authorCard())

    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    expect(store.startRestoreAuto(PROJECT)).toBe(true)
    expect(store.isRestoreAutoPending).toBe(true)
    expect(store.correctionPlacementLabel).toBeNull()
  })

  it('刷新恢复：落点与操作态一并回填仍待确认，不自动执行；确认后落点随显式保存生效', async () => {
    const card = authorCard({ status: 'deviated', deviationFlag: true })
    const store = await openCard(card)
    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    await settleMirror()
    expect(memoryStore.records.size).toBe(1)

    // 模拟刷新：全新 pinia + store，按生产路径恢复镜像
    setActivePinia(createPinia())
    const store2 = useRhythmStore()
    store2.setCardAutosaveEnabled(true)
    readRhythm.mockResolvedValue(card)
    getRhythmBoard.mockResolvedValue(emptyBoard())
    await store2.restoreCardDrafts(PROJECT)
    await store2.openCard(PROJECT, 'r1')

    expect(store2.authorCorrectionIntent).toEqual({ status: 'written', deviationFlag: false, deviationNote: '' })
    expect(store2.correctionPlacementLabel).toContain('「已写」列')
    // 恢复只回填待确认状态，不写盘
    expect(updateRhythm).not.toHaveBeenCalled()

    // 确认从恢复的落点继续：显式保存携带 afterId
    updateRhythm.mockResolvedValue(authorCard({ status: 'written', contentHash: 'hash-r2' }))
    await expect(store2.confirmAuthorCorrection(PROJECT)).resolves.toBe(true)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.authorJudgment).toBeDefined()
    expect(payload.afterId).toBe('r2')
  })

  it('外部修改到达：跨列暂存中的确认随之冻结（落点保留，冲突解决后继续处理）', async () => {
    const store = await openCard(authorCard())

    await store.crossMoveCard(PROJECT, 'r1', 'written', 'r2')
    expect(store.canConfirmAuthorCorrection).toBe(true)

    readRhythm.mockResolvedValue(authorCard({ contentHash: 'hash-external' }))
    await store.freezeForExternalChange(PROJECT, 'r1')

    expect(store.savePhase).toBe('conflict')
    expect(store.canConfirmAuthorCorrection).toBe(false)
    expect(store.correctionPlacementLabel).not.toBeNull()
  })
})
