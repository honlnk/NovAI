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
