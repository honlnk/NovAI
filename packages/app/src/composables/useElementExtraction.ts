import { ref } from 'vue'
import { previewElementExtraction, writeExtractedElements } from '@novai/core/services/element-service'
import { readFile } from '@novai/core/services/file-service'
import type {
  ElementExtractionItemView,
  ElementExtractionResultView,
  ElementWriteResultView,
} from '@novai/core/services/types'

/**
 * 要素提取流程状态（R6）。
 *
 * 编排「选章节 → 逐章提取 → 智能合并 → 候选预览 → 确认写入」的纯 UI 流程。
 * 不进 Agent 对话，不污染 chatStore.messages。状态集中在 composable 里，
 * ChatPanel 的 ExtractionFlowPanel 按 phase 渲染对应界面。
 */

export type ExtractionPhase = 'idle' | 'extracting' | 'preview' | 'writing' | 'done' | 'error'

export type ChapterPick = {
  path: string
  name: string
}

const phase = ref<ExtractionPhase>('idle')
const selectedChapters = ref<ChapterPick[]>([])
const extractionResult = ref<ElementExtractionResultView | null>(null)
const writeResult = ref<ElementWriteResultView | null>(null)
/** 提取进度：当前章节序号（从 1 起）和名称 */
const progressCurrent = ref(0)
const progressTotal = ref(0)
const progressChapterName = ref('')
const errorMessage = ref('')
/** 当前 projectId（流程进行中锁定） */
let activeProjectId = ''

/**
 * 智能合并多个章节的提取结果。
 *
 * 同 type 同 name 的候选项合并：body 用 \n\n 拼接、relatedChapters 取并集、tags 去重。
 * 不同 name 直接 concat。lastUpdatedChapter 取最后出现的章节。
 */
function mergeResults(results: ElementExtractionResultView[]): ElementExtractionResultView {
  const buckets: Array<keyof ElementExtractionResultView> = [
    'characters', 'locations', 'entities', 'timeline', 'plots', 'worldbuilding',
  ]
  const merged: ElementExtractionResultView = {
    characters: [], locations: [], entities: [], timeline: [], plots: [], worldbuilding: [],
  }

  for (const bucket of buckets) {
    const map = new Map<string, ElementExtractionItemView>()
    for (const result of results) {
      for (const item of result[bucket]) {
        const key = item.name.trim()
        const existing = map.get(key)
        if (existing) {
          // 合并：body 拼接（去重复段）、relatedChapters 并集、tags 去重、lastUpdatedChapter 取较新
          const bodyParts = [existing.body, item.body].filter(Boolean)
          existing.body = [...new Set(bodyParts)].join('\n\n')
          existing.relatedChapters = [...new Set([...existing.relatedChapters, ...item.relatedChapters])]
          existing.tags = [...new Set([...existing.tags, ...item.tags])]
          existing.lastUpdatedChapter = item.lastUpdatedChapter || existing.lastUpdatedChapter
        } else {
          map.set(key, { ...item })
        }
      }
    }
    merged[bucket] = [...map.values()]
  }

  return merged
}

/** 统计候选总数 */
export function countExtractionItems(result: ElementExtractionResultView): number {
  return (
    result.characters.length +
    result.locations.length +
    result.entities.length +
    result.timeline.length +
    result.plots.length +
    result.worldbuilding.length
  )
}

/** 重置全部状态 */
function reset() {
  phase.value = 'idle'
  selectedChapters.value = []
  extractionResult.value = null
  writeResult.value = null
  progressCurrent.value = 0
  progressTotal.value = 0
  progressChapterName.value = ''
  errorMessage.value = ''
  activeProjectId = ''
}

/**
 * 启动提取流程：逐章读取正文 → 逐章 LLM 提取 → 合并 → 进入预览态。
 */
async function startExtraction(projectId: string, chapters: ChapterPick[]) {
  if (chapters.length === 0) return
  activeProjectId = projectId
  phase.value = 'extracting'
  selectedChapters.value = chapters
  extractionResult.value = null
  writeResult.value = null
  errorMessage.value = ''
  progressTotal.value = chapters.length
  progressCurrent.value = 0

  try {
    const perChapterResults: ElementExtractionResultView[] = []
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]
      progressCurrent.value = i + 1
      progressChapterName.value = chapter.name

      const file = await readFile(projectId, chapter.path)
      const result = await previewElementExtraction({
        projectId,
        chapterContent: file.content,
        chapterPath: chapter.path,
      })
      perChapterResults.push(result)
    }

    extractionResult.value = mergeResults(perChapterResults)
    phase.value = 'preview'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '要素提取失败'
    phase.value = 'error'
  }
}

/**
 * 确认写入：调 writeExtractedElements 落盘。
 * 返回写入结果，供调用方刷新文件树。
 */
async function confirmWrite(): Promise<ElementWriteResultView | null> {
  if (!extractionResult.value || phase.value !== 'preview') return null

  phase.value = 'writing'
  try {
    const result = await writeExtractedElements({
      projectId: activeProjectId,
      extraction: extractionResult.value,
    })
    writeResult.value = result
    phase.value = 'done'
    return result
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '写入要素失败'
    phase.value = 'error'
    return null
  }
}

/** 取消流程（预览态/错误态可用），丢弃候选 */
function cancel() {
  reset()
}

/** 关闭面板（完成态/错误态），回到 idle */
function dismiss() {
  reset()
}

export function useElementExtraction() {
  return {
    phase,
    selectedChapters,
    extractionResult,
    writeResult,
    progressCurrent,
    progressTotal,
    progressChapterName,
    errorMessage,
    startExtraction,
    confirmWrite,
    cancel,
    dismiss,
  }
}
