import { extractElementsWithLlm } from '../core/elements/extractor-llm'
import { createElementDocument, writeElementDocuments } from '../core/elements/writer'
import { markProjectIndexStale } from '../core/rag/indexer'

import { requireRuntimeProject } from './project-runtime'
import type {
  ElementExtractionResultView,
  ElementWriteResultView,
} from './types'

/**
 * 使用项目配置的 LLM 对单章正文做结构化要素提取。
 * LLM 不可用（未配置、网络异常、解析失败）时直接抛错，由 UI 提示用户。
 * 不再回退到规则型正则提取——正则会生成大量低质量误匹配内容，对创作有害无益。
 */
export async function previewElementExtraction(input: {
  projectId: string
  chapterContent: string
  chapterPath?: string
}): Promise<ElementExtractionResultView> {
  const project = requireRuntimeProject(input.projectId)

  return extractElementsWithLlm({
    chapterContent: input.chapterContent,
    chapterPath: input.chapterPath,
    config: project.config,
  })
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
