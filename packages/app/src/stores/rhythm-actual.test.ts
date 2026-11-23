/**
 * 节奏写后实际值（作者字段控制权计划阶段 3）事件链测试：
 * - 实际值/关联章节/更多正文进入统一草稿：一轮保存只提交实际变更字段并携带读取时 hash；
 * - 清除哨兵（actualConflict=0 / 枚举与自评=''）只在磁盘有值时产生 null 提交；
 * - 非法实际冲突强度与空章节引用：只阻止本次写入并显示字段错误，草稿保留；
 * - 一章一卡占用报错：保存失败但草稿与输入保留；
 * - 冲突「另存副本」携带实际值与正文三节（完整人工视角新建）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { RhythmBoardView, RhythmCardView } from '@novai/core/services/types'
import { RhythmConflictError, RhythmError } from '@novai/core/types/rhythm'

import { useRhythmStore } from './rhythm'
import {
  _resetCardBackupForTest,
  _setCardBackupStoreForTest,
  type CardBackupStore,
  type PersistedCardDraftRecord,
} from '../composables/card-backup'

const { getRhythmBoard, readRhythm, updateRhythm, createRhythm } = vi.hoisted(() => ({
  getRhythmBoard: vi.fn(),
  readRhythm: vi.fn(),
  updateRhythm: vi.fn(),
  createRhythm: vi.fn(),
}))

vi.mock('@novai/core/services/rhythm-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@novai/core/services/rhythm-service')>(),
  getRhythmBoard,
  readRhythm,
  updateRhythm,
  createRhythm,
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

/** 打开节奏卡并开启自动保存（生产由 ProjectView 挂载时打开）的通用前置 */
async function openCardWithAutosave(card: RhythmCardView = view()) {
  vi.useFakeTimers()
  const store = useRhythmStore()
  store.setCardAutosaveEnabled(true)
  readRhythm.mockResolvedValue(card)
  getRhythmBoard.mockResolvedValue(emptyBoard())
  await store.openCard(PROJECT, 'r1')
  updateRhythm.mockClear()
  return store
}

/** 走完两秒去抖与写盘 promise 链 */
async function settleSave(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2500)
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

describe('节奏实际值（阶段 3：统一草稿与清除哨兵）', () => {
  it('实际值与更多正文一轮保存：只提交实际变更字段并携带读取时 hash', async () => {
    const store = await openCardWithAutosave()

    store.updateDraft({ actualConflict: 9, actualMood: '悲壮', actualNote: '按计划落地', linkBody: '上一章冷开场。', authorNoteBody: '别用倒叙。' })
    updateRhythm.mockResolvedValue(view())
    await settleSave()

    expect(updateRhythm).toHaveBeenCalledTimes(1)
    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.id).toBe('r1')
    expect(payload.actualConflict).toBe(9)
    expect(payload.actualMood).toBe('悲壮')
    expect(payload.actualNote).toBe('按计划落地')
    expect(payload.linkBody).toBe('上一章冷开场。')
    expect(payload.authorNoteBody).toBe('别用倒叙。')
    // 未修改的计划值与关联章节不在提交里
    expect(payload.plannedConflict).toBeUndefined()
    expect(payload.chapterRef).toBeUndefined()
    expect(payload.intentBody).toBeUndefined()
    expect(payload.expectedContentHash).toBe('hash-r1')
  })

  it('清除哨兵：0 与空串转 null 提交；磁盘本就是未填写的清除不产生提交', async () => {
    const written = view({
      status: 'written',
      actualConflict: 7,
      actualMood: '悲壮',
      actualHook: '悬念',
      actualPayoff: '揭秘',
      actualNote: '写长了',
      deviationFlag: false,
    })
    const store = await openCardWithAutosave(written)

    store.updateDraft({ actualConflict: 0, actualMood: '', actualHook: '', actualPayoff: '', actualNote: '' })
    updateRhythm.mockResolvedValue(view())
    await settleSave()

    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.actualConflict).toBeNull()
    expect(payload.actualMood).toBeNull()
    expect(payload.actualHook).toBeNull()
    expect(payload.actualPayoff).toBeNull()
    expect(payload.actualNote).toBeNull()

    // 未填写状态下再发清除哨兵：与磁盘一致，不产生任何提交（干净草稿不触发保存）
    readRhythm.mockResolvedValue(view())
    await store.openCard(PROJECT, 'r1')
    store.updateDraft({ actualConflict: 0, actualMood: '' })
    updateRhythm.mockClear()
    await settleSave()
    expect(updateRhythm).not.toHaveBeenCalled()
  })

  it('关联章节换章与卡名一轮保存；角色输入去重', async () => {
    const store = await openCardWithAutosave()

    store.updateDraft({ chapterRef: '第084章', name: '  第084章节奏  ', plannedCharacters: '林远、苏晚，林远' })
    updateRhythm.mockResolvedValue(view())
    await settleSave()

    const payload = updateRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.chapterRef).toBe('第084章')
    expect(payload.name).toBe('第084章节奏')
    expect(payload.plannedCharacters).toEqual(['林远', '苏晚'])
    expect(payload.expectedContentHash).toBe('hash-r1')
  })

  it('非法实际冲突强度：只阻止本次写入并显示字段错误；修正后可保存', async () => {
    const store = await openCardWithAutosave()

    store.updateDraft({ actualConflict: 99 })
    await settleSave()

    expect(updateRhythm).not.toHaveBeenCalled()
    expect(store.savePhase).toBe('failed')
    expect(store.actionError).toContain('实际冲突强度')
    // 草稿保留，修正后保存成功
    expect(store.draftActualConflict).toBe(99)
    store.updateDraft({ actualConflict: 8 })
    updateRhythm.mockResolvedValue(view({ actualConflict: 8 }))
    await settleSave()
    expect(updateRhythm).toHaveBeenCalledTimes(1)
    expect((updateRhythm.mock.calls[0]![1] as Record<string, unknown>).actualConflict).toBe(8)
  })

  it('空章节引用（防御外部写入）：阻止写入并提示在选择器中重选', async () => {
    const store = await openCardWithAutosave()

    store.updateDraft({ chapterRef: '   ' })
    await settleSave()

    expect(updateRhythm).not.toHaveBeenCalled()
    expect(store.actionError).toContain('关联章节不能为空')
  })

  it('一章一卡占用报错：保存失败但错误明确、草稿保留可改章重试', async () => {
    const store = await openCardWithAutosave()

    store.updateDraft({ chapterRef: '第090章', actualConflict: 6 })
    updateRhythm.mockRejectedValueOnce(new RhythmError('第90章 已有节奏卡「第090章节奏」（R-009）：节奏卡一章一卡，请先处理已有卡片或换一个章节'))
    await settleSave()

    expect(store.savePhase).toBe('failed')
    expect(store.actionError).toContain('一章一卡')
    expect(store.draftChapterRef).toBe('第090章')
    expect(store.draftActualConflict).toBe(6)

    store.updateDraft({ chapterRef: '第091章' })
    updateRhythm.mockResolvedValueOnce(view({ chapterRef: '第091章' }))
    await settleSave()
    expect(updateRhythm).toHaveBeenCalledTimes(2)
    const payload = updateRhythm.mock.calls[1]![1] as Record<string, unknown>
    expect(payload.chapterRef).toBe('第091章')
    expect(payload.actualConflict).toBe(6)
  })
})

describe('节奏冲突副本（阶段 3：携带实际值与正文三节）', () => {
  it('外部改盘冲突后「另存副本」：完整人工视角（磁盘 + 草稿覆盖）带实际值新建', async () => {
    const store = await openCardWithAutosave(view({
      status: 'written',
      actualConflict: 7,
      actualMood: '悲壮',
      intentBody: '本章要绷紧。',
    }))

    // 作者在途改实际值，保存撞上外部修改 → 冲突
    store.updateDraft({ actualConflict: 9, linkBody: '衔接说明。' })
    updateRhythm.mockRejectedValueOnce(new RhythmConflictError('版本冲突', {
      ...view({ contentHash: 'hash-external' }),
      body: '## 节奏意图\n\n本章要绷紧。\n',
    } as never))
    await settleSave()

    expect(store.savePhase).toBe('conflict')

    createRhythm.mockResolvedValue(view({ id: 'r-copy', name: '副本' }))
    const copy = await store.saveConflictCopy(PROJECT, '第083章节奏（副本）')
    expect(copy?.id).toBe('r-copy')

    expect(createRhythm).toHaveBeenCalledTimes(1)
    const options = createRhythm.mock.calls[0]![1] as Record<string, unknown>
    expect(options.name).toBe('第083章节奏（副本）')
    expect(options.chapterRef).toBe('第083章')
    // 草稿覆盖后的实际值随副本带走
    expect(options.actualConflict).toBe(9)
    expect(options.actualMood).toBe('悲壮')
    expect(options.linkBody).toBe('衔接说明。')
    expect(options.intentBody).toBe('本章要绷紧。')
  })
})
