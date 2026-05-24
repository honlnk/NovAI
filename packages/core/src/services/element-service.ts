import { extractElementsFromChapter } from '../core/elements/extractor'

import type { ElementExtractionResultView } from './types'

export async function previewElementExtraction(input: {
  chapterMarkdown: string
  chapterPath?: string
  systemPrompt?: string
}): Promise<ElementExtractionResultView> {
  return extractElementsFromChapter(input)
}
