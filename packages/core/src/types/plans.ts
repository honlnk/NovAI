/**
 * 创作计划板领域类型（UI 无关）。
 *
 * 一张计划卡片 = 项目根目录 plans/ 直接子级的一个 Markdown 文件：
 * 元数据放 frontmatter（id/status/order/createdAt/updatedAt），正文为自由 Markdown。
 * 展示标题取正文首个非空行并去掉行首 Markdown 标题标记，没有独立标题字段。
 */

/** 计划目录名（项目根目录下）。 */
export const PLANS_DIRECTORY = 'plans'

/** 卡片状态：inbox=收集箱 / planned=计划中 / in-progress=进行中 / done=已完成 / on-hold=已搁置。 */
export type PlanStatus = 'inbox' | 'planned' | 'in-progress' | 'done' | 'on-hold'

/** 常驻看板四栏（on-hold 通过状态筛选单独查看，不做第五列）。 */
export const PLAN_BOARD_COLUMNS: readonly PlanStatus[] = ['inbox', 'planned', 'in-progress', 'done']

/** 全部合法状态；顺序即默认筛选顺序。 */
export const PLAN_STATUSES: readonly PlanStatus[] = [...PLAN_BOARD_COLUMNS, 'on-hold']

export function isPlanStatus(value: string): value is PlanStatus {
  return (PLAN_STATUSES as readonly string[]).includes(value)
}

export type PlanCard = {
  /** 稳定标识：创建后不因正文或文件名改变。 */
  id: string
  status: PlanStatus
  /** 同列排列顺序值（可插入间隔的数值，越小越靠前）。 */
  order: number
  createdAt: string
  updatedAt: string
  /** 正文（不含 frontmatter 块）。 */
  body: string
  /** 项目内相对路径（plans/xxx.md）。 */
  sourcePath: string
}

export type PlanCardView = PlanCard & {
  /** 展示标题：正文首个非空行去掉行首标题标记；空正文为空串。 */
  title: string
  /** 正文摘要（单行折叠），列表与工具返回用。 */
  summary: string
}

/** 看板视图：每列一个有序卡片数组（含 on-hold，由调用方决定是否展示）。 */
export type PlanBoard = Readonly<Record<PlanStatus, readonly PlanCardView[]>>

/** 计划文件缺失或损坏时的读取结果（缺失元数据的卡片默认进入收集箱，不抛错）。 */
export type PlanFileReadResult =
  | { ok: true; card: PlanCard; contentHash: string }
  | {
      ok: false
      path: string
      /** 读取/解析失败原因，供扫描报告使用。 */
      reason: string
      /** 能拿到正文时保留（非法元数据不丢正文）。 */
      body: string
    }

/**
 * 目录扫描结果：可展示卡片 + 异常报告（重复稳定标识、损坏文件）。
 * 重复标识不静默合并——全部保留展示，同时报告，由修复操作处理。
 */
export type PlanScanResult = {
  cards: PlanCardView[]
  issues: PlanScanIssue[]
}

export type PlanScanIssue =
  | { kind: 'duplicate-id'; id: string; paths: string[] }
  | { kind: 'unreadable-file'; path: string; reason: string }

/** 计划领域操作失败。 */
export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanError'
  }
}

/** 正文更新冲突：文件当前内容与调用方持有的版本不一致（外部或用户已修改）。 */
export class PlanConflictError extends PlanError {
  /** 冲突文件的当前内容，供界面提示「重新读取」使用。 */
  readonly currentCard: PlanCard

  constructor(message: string, currentCard: PlanCard) {
    super(message)
    this.name = 'PlanConflictError'
    this.currentCard = currentCard
  }
}
