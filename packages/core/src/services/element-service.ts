import { extractElementsFromChapter } from '../core/elements/extractor'
import { extractElementsWithLlm } from '../core/elements/extractor-llm'
import { createElementDocument, writeElementDocuments } from '../core/elements/writer'
import { markProjectIndexStale } from '../core/rag/indexer'

import { requireRuntimeProject } from './project-runtime'
import type {
  ElementExtractionResultView,
  ElementWriteResultView,
} from './types'

export async function previewElementExtraction(input: {
  projectId: string
  chapterContent: string
  chapterPath?: string
}): Promise<ElementExtractionResultView> {
  const project = requireRuntimeProject(input.projectId)

  // 优先尝试 LLM 结构化提取；失败则降级到规则型正则提取。
  try {
    const result = await extractElementsWithLlm({
      chapterContent: input.chapterContent,
      chapterPath: input.chapterPath,
      config: project.config,
    })
    return { ...result, __source: 'llm' }
  } catch {
    const result = await extractElementsFromChapter({
      chapterContent: input.chapterContent,
      chapterPath: input.chapterPath,
    })
    return { ...result, __source: 'rule' }
  }
}

export async function writeExtractedElements(input: {
  projectId: string
  extraction: ElementExtractionResultView
}): Promise<ElementWriteResultView> {
  const project = requireRuntimeProject(input.projectId)
  const items = [
    ...input.extraction.characters,
    ...input.extraction.locations,
    ...input.extraction.entities,
    ...input.extraction.timeline,
    ...input.extraction.plots,
    ...input.extraction.worldbuilding,
  ]

  if (items.length === 0) {
    return {
      created: [],
      updated: [],
      skipped: [],
      staleIndex: false,
    }
  }

  const result = await writeElementDocuments(project.handle, items.map(createElementDocument))

  if (result.staleIndex) {
    await markProjectIndexStale(project.id, '要素文件已更新，请重建向量索引')
  }

  return result
}
