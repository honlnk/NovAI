import type { ElementType } from './rag'

export type ElementFrontmatter = {
  id: string
  type: ElementType
  name: string
  summary: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  /**
   * 关联伏笔标识列表（如 [F-001, F-003]，键名 related_foreshadowing）：
   * 主 Agent 登记的要素↔伏笔双向链（施工计划 §八）。章节文件不带伏笔字段，
   * 从人物/物品视角看「牵动了哪些伏笔」靠这枚字段。伏笔账本对要素管理员不可见，
   * 管理员只负责照原样保留，不新增不删改。
   */
  relatedForeshadowing: string[]
  updatedAt: string
}

export type ElementDocument = {
  frontmatter: ElementFrontmatter
  body: string
  sourcePath: string
}

/**
 * 要素目录条目（渐进式披露 L1，决策 0007）：只放稳定信息 type + name + summary。
 * sourcePath 仅用于 LoadElements 定位，不参与目录 digest（文件挪位置不触发目录重发）。
 */
export type ElementCatalogEntry = {
  type: ElementType
  name: string
  summary: string
  sourcePath: string
}
