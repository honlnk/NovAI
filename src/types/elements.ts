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

export type ElementExtractionItem = {
  type: ElementType
  name: string
  summary: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  body: string
}

export type ElementExtractionResult = {
  characters: ElementExtractionItem[]
  locations: ElementExtractionItem[]
  timeline: ElementExtractionItem[]
  plots: ElementExtractionItem[]
  worldbuilding: ElementExtractionItem[]
}

export type ElementWriteResult = {
  created: string[]
  updated: string[]
  skipped: string[]
}
