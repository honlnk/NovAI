import { computed } from 'vue'
import { defineStore } from 'pinia'

import {
  createRhythm,
  deleteRhythm,
  getRhythmBoard,
  readRhythm,
  splitRhythmBody,
  updateRhythm,
} from '@novai/core/services/rhythm-service'
import type {
  RhythmBoardView,
  RhythmCardSummaryView,
  RhythmCardView,
  RhythmStatusView,
} from '@novai/core/services/types'
import { RhythmConflictError } from '@novai/core/types/rhythm'
import { createCardBoardCore } from './card-board'

/**
 * 节奏卡 store：与计划/伏笔同一套看板机件（stores/card-board.ts），只声明节奏
 * 领域差异——计划值（冲突/情绪/钩子/爽点/角色/备注）+ 节奏意图正文的草稿。
 *
 * 状态不由 UI 手改（§四 状态机）：moveCard 只承载列内重排（afterId），跨列
 * 流转全靠回写 actual_* 时 core 层的偏差自动判定（保存组合里带计划值或实际值，
 * 状态由服务层算出）。偏差阈值取项目设置，与 AI RhythmUpdate 工具同口径。
 */

/** 节奏编辑草稿：null 字段 = 该字段未修改 */
export type RhythmDraft = {
  name: string | null
  plannedConflict: number | null
  plannedMood: string | null
  plannedHook: string | null
  plannedPayoff: string | null
  plannedCharacters: string | null
  plannedNote: string | null
  intentBody: string | null
}

/** 新建面板输入：章节引用与四个计划值必填（卡名与正文可选） */
export type RhythmCreateDraft = {
  name: string
  chapterRef: string
  plannedConflict: number
  plannedMood: string
  plannedHook: string
  plannedPayoff: string
  plannedCharacters: string
  intentBody: string
}

const EMPTY_DRAFT: RhythmDraft = {
  name: null,
  plannedConflict: null,
  plannedMood: null,
  plannedHook: null,
  plannedPayoff: null,
  plannedCharacters: null,
  plannedNote: null,
  intentBody: null,
}

const DRAFT_FIELDS: ReadonlyArray<keyof RhythmDraft> = [
  'name', 'plannedConflict', 'plannedMood', 'plannedHook', 'plannedPayoff',
  'plannedCharacters', 'plannedNote', 'intentBody',
]

function draftDiffers(card: RhythmCardView, draft: RhythmDraft): boolean {
  return (draft.name !== null && draft.name.trim() !== card.name)
    || (draft.plannedConflict !== null && draft.plannedConflict !== card.plannedConflict)
    || (draft.plannedMood !== null && draft.plannedMood !== card.plannedMood)
    || (draft.plannedHook !== null && draft.plannedHook !== card.plannedHook)
    || (draft.plannedPayoff !== null && draft.plannedPayoff !== card.plannedPayoff)
    || (draft.plannedCharacters !== null && draft.plannedCharacters.trim() !== card.plannedCharacters.join('、'))
    || (draft.plannedNote !== null && draft.plannedNote.trim() !== (card.plannedNote ?? ''))
    || (draft.intentBody !== null && draft.intentBody !== card.intentBody)
}

/** 角色串「甲、乙」→ 数组（顿号/逗号分隔，去空白） */
function splitCharacters(input: string): string[] {
  return input.split(/[、,，]/).map((part) => part.trim()).filter((part) => part.length > 0)
}

function hasCreateInput(draft: RhythmCreateDraft): boolean {
  return draft.chapterRef.trim() !== ''
    && Number.isInteger(draft.plannedConflict)
    && draft.plannedConflict >= 1 && draft.plannedConflict <= 10
    && draft.plannedMood !== ''
    && draft.plannedHook !== ''
    && draft.plannedPayoff !== ''
}

export const useRhythmStore = defineStore('rhythm', () => {
  const core = createCardBoardCore<
    RhythmStatusView,
    RhythmCardSummaryView,
    RhythmBoardView,
    RhythmCardView,
    RhythmDraft,
    RhythmCreateDraft
  >({
    loadBoard: (projectId) => getRhythmBoard(projectId),
    readCard: (projectId, id) => readRhythm(projectId, id),
    // 保存组合：只提交有实际变化的字段，携带读取时 hash；计划值改动会触发
    // 偏差重判定（实际值已回写时），状态由服务层自动流转；overwrite（阶段 3
    // 「采用我的当前内容」）为整份覆盖写入，不携带版本校验
    saveCard: (projectId, card, draft, options) => {
      const name = draft.name?.trim()
      const characters = draft.plannedCharacters !== null ? splitCharacters(draft.plannedCharacters) : null
      return updateRhythm(projectId, {
        id: card.id,
        ...(draft.name !== null && name !== card.name ? { name: name ?? '' } : {}),
        ...(draft.plannedConflict !== null && draft.plannedConflict !== card.plannedConflict ? { plannedConflict: draft.plannedConflict } : {}),
        ...(draft.plannedMood !== null && draft.plannedMood !== card.plannedMood ? { plannedMood: draft.plannedMood as RhythmCardView['plannedMood'] } : {}),
        ...(draft.plannedHook !== null && draft.plannedHook !== card.plannedHook ? { plannedHook: draft.plannedHook as RhythmCardView['plannedHook'] } : {}),
        ...(draft.plannedPayoff !== null && draft.plannedPayoff !== card.plannedPayoff ? { plannedPayoff: draft.plannedPayoff as RhythmCardView['plannedPayoff'] } : {}),
        ...(characters !== null && characters.join('、') !== card.plannedCharacters.join('、') ? { plannedCharacters: characters } : {}),
        ...(draft.plannedNote !== null && draft.plannedNote.trim() !== (card.plannedNote ?? '') ? { plannedNote: draft.plannedNote.trim() } : {}),
        ...(draft.intentBody !== null && draft.intentBody !== card.intentBody ? { intentBody: draft.intentBody } : {}),
        ...(options?.overwrite ? {} : { expectedContentHash: card.contentHash }),
      })
    },
    // 人工视角完整卡（磁盘基线 + 草稿覆盖），与 saveCard/draftDiffers 同一比较口径
    buildSnapshotCard: (card, draft) => {
      const name = draft.name !== null && draft.name.trim() !== card.name ? draft.name.trim() : null
      const conflict = draft.plannedConflict !== null && draft.plannedConflict !== card.plannedConflict ? draft.plannedConflict : null
      const mood = draft.plannedMood !== null && draft.plannedMood !== card.plannedMood ? draft.plannedMood : null
      const hook = draft.plannedHook !== null && draft.plannedHook !== card.plannedHook ? draft.plannedHook : null
      const payoff = draft.plannedPayoff !== null && draft.plannedPayoff !== card.plannedPayoff ? draft.plannedPayoff : null
      const characters = draft.plannedCharacters !== null && draft.plannedCharacters.trim() !== card.plannedCharacters.join('、')
        ? splitCharacters(draft.plannedCharacters)
        : null
      const note = draft.plannedNote !== null && draft.plannedNote.trim() !== (card.plannedNote ?? '') ? draft.plannedNote.trim() : null
      const intentBody = draft.intentBody !== null && draft.intentBody !== card.intentBody ? draft.intentBody : null
      return {
        ...card,
        ...(name !== null ? { name } : {}),
        ...(conflict !== null ? { plannedConflict: conflict } : {}),
        ...(mood !== null ? { plannedMood: mood as RhythmCardView['plannedMood'] } : {}),
        ...(hook !== null ? { plannedHook: hook as RhythmCardView['plannedHook'] } : {}),
        ...(payoff !== null ? { plannedPayoff: payoff as RhythmCardView['plannedPayoff'] } : {}),
        ...(characters !== null ? { plannedCharacters: characters } : {}),
        ...(note !== null ? { plannedNote: note } : {}),
        ...(intentBody !== null ? { intentBody } : {}),
      }
    },
    // 另存副本：完整卡按副本名新建（不覆盖原卡、不解冲突），正文三节与计划值
    // 全部带过去；同章重卡由服务层章号唯一性兜底报错
    saveCopy: (projectId, card, name) => createRhythm(projectId, {
      name,
      chapterRef: card.chapterRef,
      plannedConflict: card.plannedConflict,
      plannedMood: card.plannedMood,
      plannedHook: card.plannedHook,
      plannedPayoff: card.plannedPayoff,
      ...(card.plannedCharacters.length > 0 ? { plannedCharacters: [...card.plannedCharacters] } : {}),
      ...(card.plannedNote ? { plannedNote: card.plannedNote } : {}),
      ...(card.intentBody !== '' ? { intentBody: card.intentBody } : {}),
      ...(card.linkBody !== '' ? { linkBody: card.linkBody } : {}),
      ...(card.authorNoteBody !== '' ? { authorNoteBody: card.authorNoteBody } : {}),
    }),
    // 冲突字段比较：计划值与关联章节单行并排（枚举即中文），节奏意图按段落差异块
    conflictFields: (mine, disk) => [
      { key: 'name', label: '卡名', mine: mine.name, disk: disk.name, kind: 'short' },
      { key: 'chapterRef', label: '关联章节', mine: mine.chapterRef, disk: disk.chapterRef, kind: 'short' },
      { key: 'plannedConflict', label: '计划冲突强度', mine: String(mine.plannedConflict), disk: String(disk.plannedConflict), kind: 'short' },
      { key: 'plannedMood', label: '计划情绪', mine: mine.plannedMood, disk: disk.plannedMood, kind: 'short' },
      { key: 'plannedHook', label: '计划钩子', mine: mine.plannedHook, disk: disk.plannedHook, kind: 'short' },
      { key: 'plannedPayoff', label: '计划爽点', mine: mine.plannedPayoff, disk: disk.plannedPayoff, kind: 'short' },
      { key: 'plannedCharacters', label: '计划角色', mine: mine.plannedCharacters.join('、'), disk: disk.plannedCharacters.join('、'), kind: 'short' },
      { key: 'plannedNote', label: '自然语言补充', mine: mine.plannedNote ?? '（无）', disk: disk.plannedNote ?? '（无）', kind: 'short' },
      { key: 'intentBody', label: '节奏意图', mine: mine.intentBody, disk: disk.intentBody, kind: 'long' },
    ],
    // 列内重排 only：跨列流转由 actual_* 回写驱动，status 形参只是工厂签名对齐
    // （调用方只会在同列重排时触达这里，见 constants/rhythm.ts 的落点放行）
    moveCard: (projectId, id, _status, afterId, beforeId) => updateRhythm(projectId, { id, afterId, beforeId }),
    deleteCard: (projectId, id) => deleteRhythm(projectId, id),
    submitCreate: (projectId, draft) => createRhythm(projectId, {
      chapterRef: draft.chapterRef.trim(),
      plannedConflict: draft.plannedConflict,
      plannedMood: draft.plannedMood as RhythmCardView['plannedMood'],
      plannedHook: draft.plannedHook as RhythmCardView['plannedHook'],
      plannedPayoff: draft.plannedPayoff as RhythmCardView['plannedPayoff'],
      // 卡名缺省按章段生成（与 AI RhythmCreate 工具同一口径）
      name: draft.name.trim() || `${draft.chapterRef.trim().split('/').pop() ?? draft.chapterRef.trim()}节奏`,
      ...(draft.plannedCharacters.trim() !== '' ? { plannedCharacters: splitCharacters(draft.plannedCharacters) } : {}),
      ...(draft.intentBody.trim() !== '' ? { intentBody: draft.intentBody.trim() } : {}),
    }),
    // 冲突真值：整卡换新（正文三节从冲突卡 body 拆出），用户选「重新读取」时接管详情
    extractConflict: (error, card) => {
      if (!(error instanceof RhythmConflictError)) {
        return null
      }
      const sections = splitRhythmBody(error.currentCard.body)
      return { ...card, intentBody: sections.intentBody, linkBody: sections.linkBody, authorNoteBody: sections.authorNoteBody }
    },
    draftDiffers,
    isEmptyDraft: (draft) => DRAFT_FIELDS.every((field) => draft[field] === null),
    emptyDraft: () => ({ ...EMPTY_DRAFT }),
    cardTitle: (card) => card.name,
    hasCreateInput,
    clearCreateDraft: (current, submitted) => ({
      name: current.name.trim() === submitted.name.trim() ? '' : current.name,
      chapterRef: current.chapterRef.trim() === submitted.chapterRef.trim() ? '' : current.chapterRef,
      plannedConflict: current.plannedConflict === submitted.plannedConflict ? 5 : current.plannedConflict,
      plannedMood: current.plannedMood === submitted.plannedMood ? '' : current.plannedMood,
      plannedHook: current.plannedHook === submitted.plannedHook ? '无' : current.plannedHook,
      plannedPayoff: current.plannedPayoff === submitted.plannedPayoff ? '无' : current.plannedPayoff,
      plannedCharacters: current.plannedCharacters.trim() === submitted.plannedCharacters.trim() ? '' : current.plannedCharacters,
      intentBody: current.intentBody.trim() === submitted.intentBody.trim() ? '' : current.intentBody,
    }),
    emptyCreateDraft: () => ({
      name: '', chapterRef: '', plannedConflict: 5, plannedMood: '', plannedHook: '无', plannedPayoff: '无',
      plannedCharacters: '', intentBody: '',
    }),
    messages: {
      loadBoard: '读取节奏账本失败',
      readCard: '读取节奏卡失败',
      saveCard: '保存节奏卡失败',
      create: '新建节奏卡失败',
      move: '移动节奏卡失败',
      delete: '删除节奏卡失败',
    },
  })

  /* ---------- 节奏领域派生与动作 ---------- */

  /** 节奏卡名草稿（详情头部输入框）；null = 无未保存修改 */
  const draftName = computed(() => core.draft.value?.name ?? null)
  const draftPlannedConflict = computed(() => core.draft.value?.plannedConflict ?? null)
  const draftPlannedMood = computed(() => core.draft.value?.plannedMood ?? null)
  const draftPlannedHook = computed(() => core.draft.value?.plannedHook ?? null)
  const draftPlannedPayoff = computed(() => core.draft.value?.plannedPayoff ?? null)
  const draftPlannedCharacters = computed(() => core.draft.value?.plannedCharacters ?? null)
  const draftPlannedNote = computed(() => core.draft.value?.plannedNote ?? null)
  const draftIntentBody = computed(() => core.draft.value?.intentBody ?? null)

  const newCardName = computed(() => core.createDraft.value.name)
  const newCardChapterRef = computed(() => core.createDraft.value.chapterRef)
  const newCardPlannedConflict = computed(() => core.createDraft.value.plannedConflict)
  const newCardPlannedMood = computed(() => core.createDraft.value.plannedMood)
  const newCardPlannedHook = computed(() => core.createDraft.value.plannedHook)
  const newCardPlannedPayoff = computed(() => core.createDraft.value.plannedPayoff)
  const newCardPlannedCharacters = computed(() => core.createDraft.value.plannedCharacters)
  const newCardIntentBody = computed(() => core.createDraft.value.intentBody)

  const hasRequiredCreateInput = computed(() => hasCreateInput(core.createDraft.value))

  function updateDraft(partial: Partial<RhythmDraft>) {
    core.updateDraft(partial)
  }

  function updateCreateDraft(partial: Partial<RhythmCreateDraft>) {
    core.updateCreateDraft(partial)
  }

  return {
    ...core,
    draftName,
    draftPlannedConflict,
    draftPlannedMood,
    draftPlannedHook,
    draftPlannedPayoff,
    draftPlannedCharacters,
    draftPlannedNote,
    draftIntentBody,
    newCardName,
    newCardChapterRef,
    newCardPlannedConflict,
    newCardPlannedMood,
    newCardPlannedHook,
    newCardPlannedPayoff,
    newCardPlannedCharacters,
    newCardIntentBody,
    hasRequiredCreateInput,
    updateDraft,
    updateCreateDraft,
  }
})
