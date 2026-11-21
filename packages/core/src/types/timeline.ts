import type { ElementType } from './rag'

/**
 * 时间线事件账本领域类型（时间线 JSON 化改造施工计划 §八）。
 *
 * 时间线是项目级事件账本：`elements/timeline.json` 顶层为**有序标记列表**，
 * 列表顺序即故事内顺序（不表达章节顺序，也不要求所有事件有明确时间）。
 * 事件是作者理解的逻辑单位；时间标记是列表中的存储与定位单位：
 * - 点事件占一个 point 标记，标记携带事件详情；
 * - 区间事件由成对的 start / end 标记表达，start 携带详情、end 只回指 start，
 *   两端可不相邻（中间允许插入其他事件，表达并行与嵌套）。
 */

export const TIMELINE_LEDGER_PATH = 'elements/timeline.json'

export const TIMELINE_LEDGER_VERSION = 1

/** 事件标识：EVT- + 10 位小写字母数字，域内创建时生成，永久稳定。 */
export const EVENT_ID_PATTERN = /^EVT-[0-9a-z]{10}$/

/** 时间标记标识：TM- + 10 位小写字母数字，域内创建时生成，永久稳定。 */
export const MARKER_ID_PATTERN = /^TM-[0-9a-z]{10}$/

/** 叙述方式：区分「读者何时读到」与「故事里何时发生」（回忆/预言/梦境不因章节顺序被误排）。 */
export type NarrativeMode = 'current' | 'recall' | 'prophecy' | 'dream'

/**
 * 明确时间：历法自由文本 + 数值段。年必填（架空纪年可为负），季节/月/日可选。
 * 系统不理解历法语义——不换算、不据此排序；与列表顺序冲突时应提示而非静默重排。
 */
export type StoryTime = {
  /** 历法名（如「苍穹历」「公历」）；可空 = 未命名历法 */
  calendar?: string
  year: number
  season?: string
  month?: number
  day?: number
}

/** 相对时间单位：day / month / year / era 等开放短词，系统不做换算。 */
export type RelativeTime = {
  /** 锚事件标识（指逻辑事件而非标记） */
  anchorEventId: string
  offset: number
  unit: string
  direction: 'before' | 'after'
}

/** 参与要素引用：kind 恒 element；情节走 plotIds、事件互引走 causedBy，不混入此处。 */
export type TimelineParticipant = {
  kind: 'element'
  id: string
  role?: string
}

/** 章节关联：按全本章号位置引用（改名不影响关联；重号待消歧、删后同号重建无法确认）。 */
export type TimelineChapterRef = {
  chapterNumber: number
  mode: NarrativeMode
}

/**
 * 事件详情对象：挂在 point / start 标记上，end 标记不携带（不复制详情）。
 * 数组与可空字段在账本序列化中恒存在：空数组 / null 即「未填」，不靠字段缺省表达。
 */
export type TimelineEvent = {
  /** 非空短文本 */
  title: string
  /** 自然语言摘要，空串 = 未填 */
  summary: string
  /** null = 无明确时间（纯顺序时间，合法且常见） */
  storyTime: StoryTime | null
  /** null = 无相对时间 */
  relativeTime: RelativeTime | null
  participants: TimelineParticipant[]
  /** 关联情节的 ELM- 标识列表；同一事件可关联多段情节，不强制唯一归属 */
  plotIds: string[]
  chapters: TimelineChapterRef[]
  /** 因果前驱的事件标识列表（指逻辑事件） */
  causedBy: string[]
  createdAt: string
  updatedAt: string
}

/** 可作为事件参与者的要素类型：人物、地点、实体、世界观四类（情节走 plotIds）。 */
export const TIMELINE_PARTICIPANT_TYPES: readonly ElementType[] = [
  'character',
  'location',
  'entity',
  'worldbuilding',
]

/** 时间标记：列表中的存储与定位单位（判别字段 kind；end 只回指不携带详情）。 */
export type TimelineMarker =
  | { id: string; kind: 'point'; eventId: string; event: TimelineEvent }
  | { id: string; kind: 'start'; eventId: string; event: TimelineEvent }
  | { id: string; kind: 'end'; eventId: string; startId: string }

export type TimelineMarkerKind = TimelineMarker['kind']

/**
 * 账本加载时隔离出的单条非法数据（保留原始内容呈现，结构写入被阻止直至清理）。
 * 结构性约束不破：结束孤立、开始无结束、区间倒置一律隔离，绝不在载入时自动修补。
 */
export type TimelineLedgerIssue =
  | { kind: 'invalid-marker'; index: number; reason: string; raw: unknown }
  /** 与前面条目 id 相同的标记（后出现者隔离）：按 id 操作会同时命中多条，必须先清理 */
  | { kind: 'duplicate-marker-id'; index: number; id: string; reason: string; raw: unknown }
  /** eventId 被多个 point/start 复用（后出现者隔离）：同一逻辑事件只能有一处详情 */
  | { kind: 'duplicate-event-id'; index: number; eventId: string; reason: string; raw: unknown }
  /** 结束标记回指的开始不存在 / 属于别的事件 / 已被其他结束占用 */
  | { kind: 'orphan-end'; index: number; id: string; startId: string; reason: string; raw: unknown }
  /** 开始标记找不到属于自己的结束标记（含结束被隔离后落单的情形） */
  | { kind: 'unpaired-start'; index: number; id: string; eventId: string; reason: string; raw: unknown }
  /** 结束标记出现在其开始标记之前（区间倒置） */
  | { kind: 'reversed-span'; index: number; id: string; eventId: string; reason: string; raw: unknown }

/** 加载后的账本文档：合法标记 + 隔离 issue + 基线内容哈希（null = 文件尚不存在）。 */
export type TimelineLedgerDocument = {
  markers: TimelineMarker[]
  issues: TimelineLedgerIssue[]
  contentHash: string | null
}

/**
 * 插入定位（不暴露列表下标）：列表首/尾，或相对某锚标记之前/之后。
 * 锚标记必须存在于合法标记中；不得落在本区间的另一端之内（区间内部约束）。
 */
export type TimelineInsertPosition =
  | { at: 'first' }
  | { at: 'last' }
  | { at: 'before'; anchorMarkerId: string }
  | { at: 'after'; anchorMarkerId: string }
