import { computed } from 'vue'
import { defineStore } from 'pinia'

import {
  computeRhythmJudgmentPreview,
  createRhythm,
  deleteRhythm,
  getRhythmBoard,
  readRhythm,
  readRhythmDeviationThreshold,
  splitRhythmBody,
  updateRhythm,
} from '@novai/core/services/rhythm-service'
import type {
  RhythmBoardView,
  RhythmCardSummaryView,
  RhythmCardView,
  RhythmStatusView,
} from '@novai/core/services/types'
import { RHYTHM_COLUMN_LABELS, RHYTHM_STATUSES, RhythmConflictError } from '@novai/core/types/rhythm'
import type { RhythmStatus } from '@novai/core/types/rhythm'
import { createCardBoardCore } from './card-board'
import type { CardAuthorCorrectionIntent, CardConflictField, CardJudgmentOp } from './card-board'

/**
 * 节奏卡 store：与计划/伏笔同一套看板机件（stores/card-board.ts），只声明节奏
 * 领域差异——计划值（冲突/情绪/钩子/爽点/角色/备注）+ 节奏意图正文的草稿。
 *
 * 状态默认自动判定：moveCard 只承载列内重排（afterId），跨列流转靠回写
 * actual_* 时 core 层的偏差自动判定（保存组合里带计划值或实际值，状态由服务
 * 层算出）。偏差阈值取项目设置，与 AI RhythmUpdate 工具同口径。阶段 4 起作者
 * 可经「作者校正 / 恢复自动判定」明确操作接管判定结论（§五）：作为显式保存
 * 载荷与同轮未落盘草稿合并成一次 updateRhythm 提交。
 */

/** 节奏编辑草稿：null 字段 = 该字段未修改（阶段 3 纳入全部写后信息与更多正文） */
export type RhythmDraft = {
  name: string | null
  chapterRef: string | null
  plannedConflict: number | null
  plannedMood: string | null
  plannedHook: string | null
  plannedPayoff: string | null
  plannedCharacters: string | null
  plannedNote: string | null
  intentBody: string | null
  /**
   * 实际值四维 + 本章自评。清除语义与「未修改」必须区分（镜像里都能落 JSON）：
   * null = 未修改；actualConflict 的 0 与其余字段的 '' = 清除（未填写）；有值 = 已填。
   */
  actualConflict: number | null
  actualMood: string | null
  actualHook: string | null
  actualPayoff: string | null
  actualNote: string | null
  /** 上下文衔接 / 作者备注正文：'' = 清除该节 */
  linkBody: string | null
  authorNoteBody: string | null
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
  chapterRef: null,
  plannedConflict: null,
  plannedMood: null,
  plannedHook: null,
  plannedPayoff: null,
  plannedCharacters: null,
  plannedNote: null,
  intentBody: null,
  actualConflict: null,
  actualMood: null,
  actualHook: null,
  actualPayoff: null,
  actualNote: null,
  linkBody: null,
  authorNoteBody: null,
}

const DRAFT_FIELDS: ReadonlyArray<keyof RhythmDraft> = [
  'name', 'chapterRef', 'plannedConflict', 'plannedMood', 'plannedHook', 'plannedPayoff',
  'plannedCharacters', 'plannedNote', 'intentBody',
  'actualConflict', 'actualMood', 'actualHook', 'actualPayoff', 'actualNote',
  'linkBody', 'authorNoteBody',
]

/**
 * 草稿对磁盘卡的实际变更（单一比较源）：saveCard 提交负载、快照覆盖与脏判定
 * 共用。宽松 `!= null`：旧恢复镜像不含阶段 3 新字段（undefined），按「未修改」
 * 处理。清除哨兵（actualConflict=0 / 枚举与自评=''）只在与磁盘 null 态不同时
 * 产生清除提交。
 */
type RhythmChangeSet = {
  /** updateRhythm 的增量提交字段 */
  payload: Record<string, unknown>
  /** 快照卡（mine 视角）的覆盖字段 */
  snapshot: Partial<RhythmCardView>
  /** 非法输入标记：saveCard 适配层据此抛错阻止写盘 */
  actualConflictInvalid: boolean
  chapterRefEmpty: boolean
}

function rhythmChanges(card: RhythmCardView, draft: RhythmDraft): RhythmChangeSet {
  const payload: Record<string, unknown> = {}
  const snapshot: Partial<RhythmCardView> = {}
  let actualConflictInvalid = false
  let chapterRefEmpty = false

  if (draft.name != null && draft.name.trim() !== card.name) {
    payload.name = draft.name.trim()
    snapshot.name = draft.name.trim()
  }

  if (draft.chapterRef != null && draft.chapterRef.trim() !== card.chapterRef) {
    const chapterRef = draft.chapterRef.trim()
    if (chapterRef === '') {
      chapterRefEmpty = true
    } else {
      payload.chapterRef = chapterRef
      snapshot.chapterRef = chapterRef
    }
  }

  if (draft.plannedConflict != null && draft.plannedConflict !== card.plannedConflict) {
    payload.plannedConflict = draft.plannedConflict
    snapshot.plannedConflict = draft.plannedConflict
  }
  if (draft.plannedMood != null && draft.plannedMood !== card.plannedMood) {
    payload.plannedMood = draft.plannedMood as RhythmCardView['plannedMood']
    snapshot.plannedMood = draft.plannedMood as RhythmCardView['plannedMood']
  }
  if (draft.plannedHook != null && draft.plannedHook !== card.plannedHook) {
    payload.plannedHook = draft.plannedHook as RhythmCardView['plannedHook']
    snapshot.plannedHook = draft.plannedHook as RhythmCardView['plannedHook']
  }
  if (draft.plannedPayoff != null && draft.plannedPayoff !== card.plannedPayoff) {
    payload.plannedPayoff = draft.plannedPayoff as RhythmCardView['plannedPayoff']
    snapshot.plannedPayoff = draft.plannedPayoff as RhythmCardView['plannedPayoff']
  }
  if (draft.plannedCharacters != null && draft.plannedCharacters.trim() !== card.plannedCharacters.join('、')) {
    const characters = splitCharacters(draft.plannedCharacters)
    payload.plannedCharacters = characters
    snapshot.plannedCharacters = characters
  }
  if (draft.plannedNote != null && draft.plannedNote.trim() !== (card.plannedNote ?? '')) {
    payload.plannedNote = draft.plannedNote.trim()
    snapshot.plannedNote = draft.plannedNote.trim()
  }
  if (draft.intentBody != null && draft.intentBody !== card.intentBody) {
    payload.intentBody = draft.intentBody
    snapshot.intentBody = draft.intentBody
  }
  if (draft.linkBody != null && draft.linkBody !== card.linkBody) {
    payload.linkBody = draft.linkBody
    snapshot.linkBody = draft.linkBody
  }
  if (draft.authorNoteBody != null && draft.authorNoteBody !== card.authorNoteBody) {
    payload.authorNoteBody = draft.authorNoteBody
    snapshot.authorNoteBody = draft.authorNoteBody
  }

  // 实际值：0/'' = 清除（未填写）；有值 = 已填；与磁盘一致时不产生提交
  if (draft.actualConflict != null) {
    if (draft.actualConflict === 0) {
      if (card.actualConflict !== null) {
        payload.actualConflict = null
        snapshot.actualConflict = null
      }
    } else if (!Number.isInteger(draft.actualConflict) || draft.actualConflict < 1 || draft.actualConflict > 10) {
      actualConflictInvalid = true
    } else if (draft.actualConflict !== card.actualConflict) {
      payload.actualConflict = draft.actualConflict
      snapshot.actualConflict = draft.actualConflict
    }
  }

  const enumActual = <K extends 'actualMood' | 'actualHook' | 'actualPayoff'>(
    key: K,
    draftValue: string | null,
  ): void => {
    if (draftValue == null) {
      return
    }
    if (draftValue === '') {
      if (card[key] !== null) {
        payload[key] = null
        snapshot[key] = null
      }
      return
    }
    if (draftValue !== card[key]) {
      payload[key] = draftValue
      snapshot[key] = draftValue as RhythmCardView[K]
    }
  }
  enumActual('actualMood', draft.actualMood)
  enumActual('actualHook', draft.actualHook)
  enumActual('actualPayoff', draft.actualPayoff)

  if (draft.actualNote != null) {
    const trimmed = draft.actualNote.trim()
    if (trimmed === '') {
      if (card.actualNote !== null) {
        payload.actualNote = null
        snapshot.actualNote = null
      }
    } else if (trimmed !== (card.actualNote ?? '')) {
      payload.actualNote = trimmed
      snapshot.actualNote = trimmed
    }
  }

  return { payload, snapshot, actualConflictInvalid, chapterRefEmpty }
}

/** 草稿与磁盘卡是否有实际差异；非法输入也算待处理（不清会话）。 */
function draftDiffers(card: RhythmCardView, draft: RhythmDraft): boolean {
  const changes = rhythmChanges(card, draft)
  return Object.keys(changes.payload).length > 0 || changes.actualConflictInvalid || changes.chapterRefEmpty
}

/** 角色串「甲、乙」→ 数组（顿号/逗号分隔，去空白去重保首现） */
function splitCharacters(input: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of input.split(/[、,，]/).map((item) => item.trim())) {
    if (part.length > 0 && !seen.has(part)) {
      seen.add(part)
      result.push(part)
    }
  }
  return result
}

function hasCreateInput(draft: RhythmCreateDraft): boolean {
  return draft.chapterRef.trim() !== ''
    && Number.isInteger(draft.plannedConflict)
    && draft.plannedConflict >= 1 && draft.plannedConflict <= 10
    && draft.plannedMood !== ''
    && draft.plannedHook !== ''
    && draft.plannedPayoff !== ''
}

/**
 * 显式判定操作 → updateRhythm 参数（阶段 4 §五.2.2）：作者校正/恢复自动作为
 * 保存载荷与草稿增量合并为一次提交（core 层做校验表与互斥检查）。操作态经
 * 通用层镜像恢复，这里只负责组合；状态枚举先过一道防御（镜像记录是本地数据，
 * 不信任其形状）。
 */
function judgmentOpExtras(op?: CardJudgmentOp): Record<string, unknown> {
  if (!op) {
    return {}
  }
  if (op.kind === 'restoreAuto') {
    return { restoreAutoJudgment: true }
  }
  const status = op.status as RhythmStatus
  if (!(RHYTHM_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`作者校正状态非法：${op.status}`)
  }
  return {
    authorJudgment: {
      status,
      deviationFlag: op.deviationFlag,
      ...(op.deviationNote !== '' ? { deviationNote: op.deviationNote } : {}),
    },
  }
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
    // 保存组合：只提交有实际变化的字段，携带读取时 hash；计划值/实际值/关联章节/
    // 正文三节一轮保存不拆请求（作者字段控制权计划阶段 3）；计划值或实际值改动会
    // 触发偏差重判定，状态由服务层自动流转；overwrite（「采用我的当前内容」）
    // 为整份覆盖写入，不携带版本校验；judgmentOp（阶段 4 显式判定保存）与草稿
    // 增量合并为同一轮提交——一次保存同时落字段与判定结论；placement（阶段 5
    // 跨列落点）只在显式判定保存里随 judgmentOp 携带，落点列由提交的校正状态决定
    saveCard: (projectId, card, draft, options) => {
      const changes = rhythmChanges(card, draft)
      if (changes.actualConflictInvalid) {
        throw new Error('实际冲突强度非法：须为 1~10 的整数')
      }
      if (changes.chapterRefEmpty) {
        throw new Error('关联章节不能为空：请在选择器中选择或新建章节')
      }
      return updateRhythm(projectId, {
        id: card.id,
        ...changes.payload,
        ...judgmentOpExtras(options?.judgmentOp),
        ...(options?.placement ? {
          afterId: options.placement.afterId,
          ...(options.placement.beforeId !== undefined ? { beforeId: options.placement.beforeId } : {}),
        } : {}),
        ...(options?.overwrite ? {} : { expectedContentHash: card.contentHash }),
      })
    },
    // 人工视角完整卡（磁盘基线 + 草稿覆盖），与 saveCard/draftDiffers 同一比较口径
    buildSnapshotCard: (card, draft) => {
      const changes = rhythmChanges(card, draft)
      return {
        ...card,
        ...changes.snapshot,
      }
    },
    // 另存副本：完整人工视角按副本名新建（不覆盖原卡、不解冲突），计划值、实际值
    // 与正文三节全部带过去；同章占用由服务层一章一卡守卫明确报错（阶段 3）；
    // 作者校正结论一并携带（阶段 4：副本与原卡同一份人工判定）
    saveCopy: (projectId, card, name) => createRhythm(projectId, {
      name,
      chapterRef: card.chapterRef,
      plannedConflict: card.plannedConflict,
      plannedMood: card.plannedMood,
      plannedHook: card.plannedHook,
      plannedPayoff: card.plannedPayoff,
      ...(card.plannedCharacters.length > 0 ? { plannedCharacters: [...card.plannedCharacters] } : {}),
      ...(card.plannedNote ? { plannedNote: card.plannedNote } : {}),
      ...(card.actualConflict !== null || card.actualMood !== null || card.actualHook !== null || card.actualPayoff !== null || card.actualNote !== null ? {
        actualConflict: card.actualConflict,
        actualMood: card.actualMood,
        actualHook: card.actualHook,
        actualPayoff: card.actualPayoff,
        ...(card.actualNote !== null ? { actualNote: card.actualNote } : {}),
      } : {}),
      ...(card.judgmentSource === 'author' ? {
        authorJudgment: {
          status: card.status,
          deviationFlag: card.deviationFlag,
          ...(card.authorDeviationNote !== null ? { deviationNote: card.authorDeviationNote } : {}),
        },
      } : {}),
      ...(card.intentBody !== '' ? { intentBody: card.intentBody } : {}),
      ...(card.linkBody !== '' ? { linkBody: card.linkBody } : {}),
      ...(card.authorNoteBody !== '' ? { authorNoteBody: card.authorNoteBody } : {}),
    }),
    // 冲突字段比较：计划值、实际值与正文三节并排（枚举即中文），正文按段落差异块
    conflictFields: (mine, disk) => [
      { key: 'name', label: '卡名', mine: mine.name, disk: disk.name, kind: 'short' },
      { key: 'chapterRef', label: '关联章节', mine: mine.chapterRef, disk: disk.chapterRef, kind: 'short' },
      { key: 'plannedConflict', label: '计划冲突强度', mine: String(mine.plannedConflict), disk: String(disk.plannedConflict), kind: 'short' },
      { key: 'plannedMood', label: '计划情绪', mine: mine.plannedMood, disk: disk.plannedMood, kind: 'short' },
      { key: 'plannedHook', label: '计划钩子', mine: mine.plannedHook, disk: disk.plannedHook, kind: 'short' },
      { key: 'plannedPayoff', label: '计划爽点', mine: mine.plannedPayoff, disk: disk.plannedPayoff, kind: 'short' },
      { key: 'plannedCharacters', label: '计划角色', mine: mine.plannedCharacters.join('、'), disk: disk.plannedCharacters.join('、'), kind: 'short' },
      { key: 'plannedNote', label: '自然语言补充', mine: mine.plannedNote ?? '（无）', disk: disk.plannedNote ?? '（无）', kind: 'short' },
      { key: 'actualConflict', label: '实际冲突强度', mine: mine.actualConflict === null ? '（未填写）' : String(mine.actualConflict), disk: disk.actualConflict === null ? '（未填写）' : String(disk.actualConflict), kind: 'short' },
      { key: 'actualMood', label: '实际情绪', mine: mine.actualMood ?? '（未填写）', disk: disk.actualMood ?? '（未填写）', kind: 'short' },
      { key: 'actualHook', label: '实际钩子', mine: mine.actualHook ?? '（未填写）', disk: disk.actualHook ?? '（未填写）', kind: 'short' },
      { key: 'actualPayoff', label: '实际爽点', mine: mine.actualPayoff ?? '（未填写）', disk: disk.actualPayoff ?? '（未填写）', kind: 'short' },
      { key: 'actualNote', label: '本章自评', mine: mine.actualNote ?? '（未填写）', disk: disk.actualNote ?? '（未填写）', kind: 'short' },
      { key: 'judgmentSource', label: '判定来源', mine: mine.judgmentSource === 'author' ? '作者校正' : '自动判定', disk: disk.judgmentSource === 'author' ? '作者校正' : '自动判定', kind: 'short' },
      ...(mine.authorDeviationNote !== null || disk.authorDeviationNote !== null ? [{
        key: 'authorDeviationNote',
        label: '人工偏差说明',
        mine: mine.authorDeviationNote ?? '（无）',
        disk: disk.authorDeviationNote ?? '（无）',
        kind: 'short',
      } as CardConflictField] : []),
      { key: 'intentBody', label: '节奏意图', mine: mine.intentBody, disk: disk.intentBody, kind: 'long' },
      { key: 'linkBody', label: '上下文衔接', mine: mine.linkBody, disk: disk.linkBody, kind: 'long' },
      { key: 'authorNoteBody', label: '作者备注', mine: mine.authorNoteBody, disk: disk.authorNoteBody, kind: 'long' },
    ],
    // 列内重排 only（阶段 5 §六）：跨列拖拽不走这里——RhythmBoardPanel 分流到
    // crossMove（作者校正操作态 + 暂存落点），「应用校正」一次保存才移动看板
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
    // 判定操作态入口（阶段 4）：校正表单默认值 = 卡片当前有效结论（作者卡回填
    // 人工结论与说明，自动卡回填自动结果）
    judgment: {
      defaultCorrection: (card): CardAuthorCorrectionIntent => ({
        status: card.status,
        deviationFlag: card.deviationFlag,
        deviationNote: card.authorDeviationNote ?? '',
      }),
    },
    draftDiffers,
    isEmptyDraft: (draft) => DRAFT_FIELDS.every((field) => draft[field] == null),
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

  /* ----- 判定来源派生（阶段 4 §五：徽标、阈值提示、比较值警告、恢复自动预演） ----- */

  /** 当前打开卡片的判定来源（'auto' 无卡时的兜底） */
  const judgmentSource = computed(() => core.activeCard.value?.judgmentSource ?? 'auto')
  /** 阈值待复核：最近一次判定采用的阈值与当前项目阈值不一致（§五.3 轻量提示） */
  const thresholdPending = computed(() => core.activeCard.value?.thresholdPending === true)
  /** 历史人工说明：恢复自动后保留的作者说明（默认折叠查看，不静默删除） */
  const historicalAuthorNote = computed(() => {
    const card = core.activeCard.value
    return card !== null && card.judgmentSource === 'auto' ? card.authorDeviationNote : null
  })

  /** 比较值保存前警告（§五.3）：作者卡上正在修改计划/实际比较项——保存这些值后将按新值重算并恢复自动 */
  const comparisonEditWarning = computed(() => {
    const card = core.activeCard.value
    const draft = core.draft.value
    if (!card || !draft || card.judgmentSource !== 'author') {
      return false
    }
    const changes = rhythmChanges(card, draft)
    return (['plannedConflict', 'plannedMood', 'plannedHook', 'plannedPayoff',
      'actualConflict', 'actualMood', 'actualHook', 'actualPayoff'] as const)
      .some((key) => key in changes.payload)
  })

  /** 恢复自动确认预演（§五.3）：磁盘卡 + 草稿合并值按当前项目阈值的自动结论 */
  const restoreAutoPreview = computed(() => {
    const card = core.activeCard.value
    if (!card) {
      return null
    }
    const draft = core.draft.value
    const mergeActualNumber = (draftValue: number | null, disk: number | null): number | null =>
      draftValue == null ? disk : (draftValue === 0 ? null : draftValue)
    const mergeActualEnum = <T extends string>(draftValue: string | null, disk: T | null): T | null =>
      draftValue == null ? disk : (draftValue === '' ? null : (draftValue as T))
    const projectId = core.getActiveProjectId()
    if (projectId === null) {
      return null
    }
    return computeRhythmJudgmentPreview({
      plannedConflict: draft?.plannedConflict ?? card.plannedConflict,
      plannedMood: (draft?.plannedMood ?? card.plannedMood) as RhythmCardView['plannedMood'],
      plannedHook: (draft?.plannedHook ?? card.plannedHook) as RhythmCardView['plannedHook'],
      plannedPayoff: (draft?.plannedPayoff ?? card.plannedPayoff) as RhythmCardView['plannedPayoff'],
      actualConflict: mergeActualNumber(draft?.actualConflict ?? null, card.actualConflict),
      actualMood: mergeActualEnum(draft?.actualMood ?? null, card.actualMood),
      actualHook: mergeActualEnum(draft?.actualHook ?? null, card.actualHook),
      actualPayoff: mergeActualEnum(draft?.actualPayoff ?? null, card.actualPayoff),
    }, readRhythmDeviationThreshold(projectId))
  })

  /* ----- 跨列拖拽（阶段 5 §六）：落点暂存 + 应用校正一次保存 ----- */

  /** 校正表单里的待确认落点描述（null = 无跨列暂存）：应用后将移动到目标列的位置 */
  const correctionPlacementLabel = computed(() => {
    const placement = core.pendingPlacement.value
    if (!placement) {
      return null
    }
    const columnLabel = RHYTHM_COLUMN_LABELS[placement.status as RhythmStatus] ?? placement.status
    const board = core.board.value
    const anchorName = (id: string): string => {
      const summary = board
        ? (Object.values(board.columns) as RhythmCardSummaryView[][])
            .flat().find((card) => card.id === id)
        : undefined
      return summary?.name ?? id
    }
    const anchor = placement.beforeId != null
      ? `「${anchorName(placement.beforeId)}」之前`
      : placement.afterId != null
        ? `「${anchorName(placement.afterId)}」之后`
        : '列尾'
    return `应用后将移动到「${columnLabel}」列（${anchor}）；取消或离开不动原位`
  })

  /**
   * 跨列拖拽松手（阶段 5 §六）：打开该卡详情并进入作者校正操作态——目标状态
   * 已选中、落点暂存待确认；应用前看板保持原位。不先修改真实看板，也不直接
   * 改状态。
   */
  async function crossMoveCard(
    projectId: string,
    id: string,
    status: RhythmStatusView,
    afterId: string | null,
    beforeId?: string | null,
  ): Promise<void> {
    await core.openCard(projectId, id)
    core.startAuthorCorrection(
      projectId,
      { status },
      { status, afterId, ...(beforeId !== undefined ? { beforeId } : {}) },
    )
  }

  /** 节奏卡名草稿（详情头部输入框）；null = 无未保存修改 */
  const draftName = computed(() => core.draft.value?.name ?? null)
  const draftChapterRef = computed(() => core.draft.value?.chapterRef ?? null)
  const draftPlannedConflict = computed(() => core.draft.value?.plannedConflict ?? null)
  const draftPlannedMood = computed(() => core.draft.value?.plannedMood ?? null)
  const draftPlannedHook = computed(() => core.draft.value?.plannedHook ?? null)
  const draftPlannedPayoff = computed(() => core.draft.value?.plannedPayoff ?? null)
  const draftPlannedCharacters = computed(() => core.draft.value?.plannedCharacters ?? null)
  const draftPlannedNote = computed(() => core.draft.value?.plannedNote ?? null)
  const draftIntentBody = computed(() => core.draft.value?.intentBody ?? null)
  /** 实际值草稿（null = 未修改；0/'' = 清除） */
  const draftActualConflict = computed(() => core.draft.value?.actualConflict ?? null)
  const draftActualMood = computed(() => core.draft.value?.actualMood ?? null)
  const draftActualHook = computed(() => core.draft.value?.actualHook ?? null)
  const draftActualPayoff = computed(() => core.draft.value?.actualPayoff ?? null)
  const draftActualNote = computed(() => core.draft.value?.actualNote ?? null)
  /** 更多正文草稿（null = 未修改；'' = 清除该节） */
  const draftLinkBody = computed(() => core.draft.value?.linkBody ?? null)
  const draftAuthorNoteBody = computed(() => core.draft.value?.authorNoteBody ?? null)

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
    judgmentSource,
    thresholdPending,
    historicalAuthorNote,
    comparisonEditWarning,
    restoreAutoPreview,
    correctionPlacementLabel,
    crossMoveCard,
    draftName,
    draftChapterRef,
    draftPlannedConflict,
    draftPlannedMood,
    draftPlannedHook,
    draftPlannedPayoff,
    draftPlannedCharacters,
    draftPlannedNote,
    draftIntentBody,
    draftActualConflict,
    draftActualMood,
    draftActualHook,
    draftActualPayoff,
    draftActualNote,
    draftLinkBody,
    draftAuthorNoteBody,
    newCardName,
    newCardChapterRef,
    newCardPlannedConflict,
    newCardPlannedMood,
    newCardPlannedHook,
    newCardPlannedPayoff,
    newCardPlannedCharacters,
    newCardCharacters: newCardPlannedCharacters,
    newCardIntentBody,
    hasRequiredCreateInput,
    updateDraft,
    updateCreateDraft,
  }
})
