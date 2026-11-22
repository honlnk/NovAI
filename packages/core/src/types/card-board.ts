/**
 * 看板卡片通用类型（UI 无关，《创作心智模块施工计划》§10）：
 * 计划（plans/）、伏笔（foreshadowing/）、节奏卡（rhythm/）三类
 * 「一张卡片一个 Markdown 文件 + frontmatter 元数据 + 看板列」目录的共享骨架。
 *
 * 泛型参数 TStatus 是各领域自己的状态枚举；各领域卡片在此骨架上扩展自己的
 * frontmatter 字段（伏笔的回收窗口、节奏卡的计划值/实际值等）。
 */

/** 看板卡片公共骨架：任何看板卡片目录里的卡片都带这六个字段。 */
export type CardBoardCard<TStatus extends string> = {
  /** 稳定标识：创建后不因正文或文件名改变。 */
  id: string
  status: TStatus
  /** 同列排列顺序值（可插入间隔的数值，越小越靠前）。 */
  order: number
  createdAt: string
  updatedAt: string
  /** 正文（不含 frontmatter 块）。 */
  body: string
  /** 项目内相对路径（<目录>/xxx.md）。 */
  sourcePath: string
}

/** 排除 sourcePath 的卡片骨架（创建与序列化用）。 */
export type CardBoardCardBase<TStatus extends string> = Omit<CardBoardCard<TStatus>, 'sourcePath'>

/** 目录扫描异常：重复稳定标识与损坏文件（重复不静默合并，全部保留展示由修复处理）。 */
export type CardBoardScanIssue =
  | { kind: 'duplicate-id'; id: string; paths: string[] }
  | { kind: 'unreadable-file'; path: string; reason: string }

/** 目录扫描结果：可展示卡片 + 异常报告。 */
export type CardBoardScanResult<TCard> = {
  cards: TCard[]
  issues: CardBoardScanIssue[]
}

/**
 * 看板领域操作失败公共基类（各领域错误类继承它，便于跨领域统一捕获）。
 * 冲突错误（文件当前内容与调用方持有的版本不一致）由各领域在子类上携带
 * 自己的当前卡片类型——共享的是「hash 比对 + 冲突报错」逻辑（card-board/store），不是类。
 */
export class CardBoardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardBoardError'
  }
}
