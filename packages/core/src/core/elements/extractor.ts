import type { ElementExtractionResult } from '../../types/elements'

export async function extractElementsFromChapter(_input: {
  chapterMarkdown: string
  chapterPath?: string
  systemPrompt?: string
}): Promise<ElementExtractionResult> {
  return {
    characters: [],
    locations: [],
    timeline: [],
    plots: [],
    worldbuilding: [],
  }
}
