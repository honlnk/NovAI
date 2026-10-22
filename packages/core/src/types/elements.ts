import type { ElementType } from './rag'

export type ElementFrontmatter = {
  id: string
  type: ElementType
  name: string
  summary: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
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
