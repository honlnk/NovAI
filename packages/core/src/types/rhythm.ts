/**
 * 节奏卡领域类型（UI 无关，《创作心智模块施工计划》§四）。
 *
 * 一张节奏卡 = 项目根目录 rhythm/ 直接子级的一个 Markdown 文件：计划值与实际值放
 * frontmatter，正文固定三节——「节奏意图」（本章要什么温度）、「上下文衔接」
 * （前后章的温度差）与「作者备注」。节奏卡是作者对读者感受的规划账本：记录
 * 「想让读者在本章感受到什么、实际感受到了什么」，它只是规划与回写的对照，
 * 永远不写入章节文件本身。
 *
 * 状态即看板列（三列，不像伏笔那样折叠）：planned=规划中 / written=已写 /
 * deviated=偏差。written↔deviated 与偏差标记（deviationFlag/deviationNote）由
 * 系统在回写实际值时按阈值自动计算，不接受外部设置（见 rhythm/store）。
 */

import { CardBoardCard, CardBoardError } from './card-board'

/** 节奏卡目录名（项目根目录下）。 */
export const RHYTHM_DIRECTORY = 'rhythm'

/**
 * 节奏卡三状态（frontmatter 精确值）：
 * planned=规划中 / written=已写（偏差在阈值内）/ deviated=偏差（超阈值，需作者注意）。
 */
export type RhythmStatus = 'planned' | 'written' | 'deviated'

/** 全部合法状态。 */
export const RHYTHM_STATUSES: readonly RhythmStatus[] = ['planned', 'written', 'deviated']

export function isRhythmStatus(value: string): value is RhythmStatus {
  return (RHYTHM_STATUSES as readonly string[]).includes(value)
}

/**
 * 情绪基调枚举（frontmatter 存中文精确值）：本章想让读者处在什么情绪里。
 */
export type RhythmMood =
  | '压抑'
  | '紧张'
  | '悲壮'
  | '轻松'
  | '温馨'
  | '悬疑'
  | '爽感'
  | '恐怖'
  | '悲伤'
  | '平静'

/** 全部合法情绪基调。 */
export const RHYTHM_MOODS: readonly RhythmMood[] = [
  '压抑',
  '紧张',
  '悲壮',
  '轻松',
  '温馨',
  '悬疑',
  '爽感',
  '恐怖',
  '悲伤',
  '平静',
]

/** 情绪基调说明（枚举挑选与提示用）。 */
export const RHYTHM_MOOD_DESCRIPTIONS: Record<RhythmMood, string> = {
  压抑: '主角处于困境，读者感到憋屈',
  紧张: '冲突正在升级，读者屏息',
  悲壮: '有代价的胜利或牺牲',
  轻松: '日常、幽默、无压力',
  温馨: '情感暖色，人际亲密',
  悬疑: '信息不完整，读者好奇',
  爽感: '主角占优，读者畅快',
  恐怖: '威胁迫近，读者不安',
  悲伤: '失去、离别、遗憾',
  平静: '过渡、铺垫、无强烈情绪',
}

export function isRhythmMood(value: string): value is RhythmMood {
  return (RHYTHM_MOODS as readonly string[]).includes(value)
}

/**
 * 章末钩子类型枚举：章末留给读者的牵引力；「无」= 章末收束、无钩子。
 */
export type RhythmHook = '悬念' | '危机' | '反转' | '情感爆发' | '揭秘' | '无'

/** 全部合法章末钩子类型。 */
export const RHYTHM_HOOKS: readonly RhythmHook[] = ['悬念', '危机', '反转', '情感爆发', '揭秘', '无']

export function isRhythmHook(value: string): value is RhythmHook {
  return (RHYTHM_HOOKS as readonly string[]).includes(value)
}

/**
 * 爽点类型枚举：本章给读者的回报；「无」= 本章无明确爽点。
 */
export type RhythmPayoff = '升级' | '打脸' | '收获' | '情感' | '揭秘' | '无'

/** 全部合法爽点类型。 */
export const RHYTHM_PAYOFFS: readonly RhythmPayoff[] = ['升级', '打脸', '收获', '情感', '揭秘', '无']

export function isRhythmPayoff(value: string): value is RhythmPayoff {
  return (RHYTHM_PAYOFFS as readonly string[]).includes(value)
}

/**
 * 看板三列：状态即列（不折叠）。planned=规划中 / written=已写 / deviated=偏差。
 */
export type RhythmColumn = 'planned' | 'written' | 'deviated'

export const RHYTHM_COLUMNS: readonly RhythmColumn[] = ['planned', 'written', 'deviated']

/** 看板列展示名（列头/筛选用）。 */
export const RHYTHM_COLUMN_LABELS: Record<RhythmColumn, string> = {
  planned: '规划中',
  written: '已写',
  deviated: '偏差',
}

/** 节奏卡 = 通用看板卡片骨架 + 节奏领域字段（计划值 / 实际值 / 偏差标记）。 */
export type RhythmCard = CardBoardCard<RhythmStatus> & {
  /** 节奏卡名（作者可改；名称变化时文件名同步）。 */
  name: string
  /** 关联章节（完整路径「卷/章」，如 第二卷/第083章）。 */
  chapterRef: string
  /** 所属卷（「卷/章」的卷段）。 */
  volume: string
  /** 计划冲突强度（1~10 整数）。 */
  plannedConflict: number
  /** 计划情绪基调。 */
  plannedMood: RhythmMood
  /** 计划章末钩子类型。 */
  plannedHook: RhythmHook
  /** 计划爽点类型。 */
  plannedPayoff: RhythmPayoff
  /** 计划出场主要角色。 */
  plannedCharacters: readonly string[]
  /** 自然语言补充（可空串，如「大高潮后的喘息章」）。 */
  plannedNote: string
  /** 实际冲突强度；未回写为 null。 */
  actualConflict: number | null
  /** 实际情绪基调；未回写为 null。 */
  actualMood: RhythmMood | null
  /** 实际章末钩子；未回写为 null。 */
  actualHook: RhythmHook | null
  /** 实际爽点类型；未回写为 null。 */
  actualPayoff: RhythmPayoff | null
  /** AI/作者对本章节奏的自评；未回写为 null。 */
  actualNote: string | null
  /** 计划与实际偏差是否超阈值（回写实际值时系统自动计算）。 */
  deviationFlag: boolean
  /** 偏差说明（命中维度的拼接描述）；无偏差为 null。 */
  deviationNote: string | null
}

export type RhythmCardView = RhythmCard & {
  /** 摘要（正文「节奏意图」节首个非空行，作看板/列表摘要）。 */
  summary: string
}

/** 目录扫描结果（与伏笔同款骨架，卡片类型具体化）。 */
export type RhythmScanResult = {
  cards: RhythmCardView[]
  issues: RhythmScanIssue[]
}

export type RhythmScanIssue =
  | { kind: 'duplicate-id'; id: string; paths: string[] }
  | { kind: 'unreadable-file'; path: string; reason: string }

/** 节奏卡领域操作失败。 */
export class RhythmError extends CardBoardError {
  constructor(message: string) {
    super(message)
    this.name = 'RhythmError'
  }
}

/** 正文/字段更新冲突：文件当前内容与调用方持有的版本不一致（外部或用户已修改）。 */
export class RhythmConflictError extends RhythmError {
  /** 冲突文件的当前内容，供界面提示「重新读取」使用。 */
  readonly currentCard: RhythmCard

  constructor(message: string, currentCard: RhythmCard) {
    super(message)
    this.name = 'RhythmConflictError'
    this.currentCard = currentCard
  }
}
