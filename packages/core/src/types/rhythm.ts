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
 * deviated=偏差。默认自动判定：保存比较值（计划四项 / 实际四项）时按当时阈值
 * 重算状态与偏差（见 rhythm/store）；作者可经显式操作校正结论或恢复自动
 * （作者字段控制权计划 §五），AI 工具不提供校正参数。
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

/**
 * 判定来源（作者字段控制权计划 §五.1）：状态/偏差标记/说明的有效结论由谁给出。
 * 不是全局模式开关，也不是第二套看板——三列、曲线、摘要读同一份有效结果。
 */
export type RhythmJudgmentSource = 'auto' | 'author'

/** 全部合法判定来源。 */
export const RHYTHM_JUDGMENT_SOURCES: readonly RhythmJudgmentSource[] = ['auto', 'author']

export function isRhythmJudgmentSource(value: string): value is RhythmJudgmentSource {
  return (RHYTHM_JUDGMENT_SOURCES as readonly string[]).includes(value)
}

/**
 * 作者校正载荷（§五.2 校验表）：仅由作者详情中的明确操作触发（应用校正 / 看板跨列
 * 暂存落点），AI 普通更新工具不接受。校验通过后 status/deviationFlag 直接采用，
 * 说明进 authorDeviationNote（不碰系统 deviationNote——两份说明独立留存）。
 */
export type RhythmAuthorJudgment = {
  status: RhythmStatus
  deviationFlag: boolean
  /** 有偏差时必填（trim 后非空）；无偏差时缺省/null = 清除旧作者说明。 */
  deviationNote?: string | null
}

/** 节奏卡 = 通用看板卡片骨架 + 节奏领域字段（计划值 / 实际值 / 偏差标记）。 */
export type RhythmCard = CardBoardCard<RhythmStatus> & {
  /** 节奏卡名（作者可改；名称变化时文件名同步）。 */
  name: string
  /** 关联章节（如 第083章；作者可用「卷/章」写法自由标注，不做卷级机制）。 */
  chapterRef: string
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
  /** 判定来源（阶段 4 §五.1）：auto=按比较值与阈值计算；author=作者明确校正。旧文件缺省按 auto 解释。 */
  judgmentSource: RhythmJudgmentSource
  /** 作者校正的偏差说明（作者模式的有效说明；恢复自动后保留为历史，不再有效）。 */
  authorDeviationNote: string | null
  /** 最近一次判定（自动重算或作者校正保存）采用的冲突阈值；null 按默认阈值 3 解释（旧卡）。 */
  lastJudgmentThreshold: number | null
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
