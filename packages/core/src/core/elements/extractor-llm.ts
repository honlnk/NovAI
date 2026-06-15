import { streamChatCompletion } from '../llm/client'

import type { ElementExtractionItem, ElementExtractionResult } from '../../types/elements'
import type { ElementType } from '../../types/rag'
import type { ProjectConfig } from '../../types/project'

type ExtractionBucket = keyof ElementExtractionResult

const BUCKET_TYPE_MAP: Record<ExtractionBucket, ElementType> = {
  characters: 'character',
  locations: 'location',
  entities: 'entity',
  timeline: 'timeline',
  plots: 'plot',
  worldbuilding: 'worldbuilding',
}

/**
 * 调用项目配置的 LLM，对单章正文做结构化要素提取。
 * 提取失败（未配置 LLM、网络异常、解析失败）时抛错，由上层决定是否降级到正则提取。
 */
export async function extractElementsWithLlm(input: {
  chapterContent: string
  chapterPath?: string
  config: ProjectConfig
}): Promise<ElementExtractionResult> {
  const { llm } = input.config

  if (!llm.baseUrl.trim() || !llm.apiKey.trim() || !llm.model.trim()) {
    throw new Error('未配置 LLM，无法执行 AI 要素提取')
  }

  const chapterRef = input.chapterPath?.trim() || '当前章节'
  const systemPrompt = buildExtractionSystemPrompt()
  const userPrompt = buildExtractionUserPrompt(input.chapterContent, chapterRef)

  const rawText = await streamChatCompletion(
    {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      systemPrompt,
      instruction: userPrompt,
    },
    () => {
      // 要素提取是一次性结构化输出，不需要消费流式增量；留空回调即可。
    },
  )

  return parseExtractionResponse(rawText, chapterRef)
}

function buildExtractionSystemPrompt(): string {
  return [
    '你是小说创作要素抽取助手。你的任务是从单章正文中识别并结构化抽取六类要素。',
    '',
    '【六类要素定义】',
    '- characters：登场人物，记录姓名、当前状态、关键行为。',
    '- locations：出现的地点、场景、场所。',
    '- entities：具体实体，包括武功、武器、坐骑、丹药、信物、法器等。',
    '- timeline：本章关键事件的时间顺序节点。',
    '- plots：本章核心情节事件。',
    '- worldbuilding：涉及的设定、规则、体系、组织、境界等抽象世界观线索。',
    '',
    '【输出要求】',
    '- 只输出一个 JSON 对象，不要输出任何解释、前言、注释或代码块标记。',
    '- JSON 顶层包含六个数组字段：characters、locations、entities、timeline、plots、worldbuilding。',
    '- 每个元素是一个对象，字段：name（字符串，必填）、summary（简短描述）、body（较详细说明，可包含原文线索）。',
    '- 没有对应要素的类别返回空数组。',
    '- 不要编造正文中没有的要素；只抽取本章实际出现的内容。',
    '- 全部使用中文。',
    '',
    '【输出 JSON 结构示例】',
    '{"characters":[{"name":"示例人物","summary":"本章做了什么","body":"详细线索"}],"locations":[],"entities":[],"timeline":[],"plots":[],"worldbuilding":[]}',
  ].join('\n')
}

function buildExtractionUserPrompt(chapterContent: string, chapterRef: string): string {
  const content = chapterContent.replace(/\r\n/g, '\n').trim()
  return [
    `章节标识：${chapterRef}`,
    '',
    '以下是章节正文，请抽取其中的要素并以 JSON 输出：',
    '',
    content,
  ].join('\n')
}

/**
 * 把模型返回的文本解析成 ElementExtractionResult。
 * 容错策略：提取 JSON 代码块、逐字段校验、非法项跳过。
 */
export function parseExtractionResponse(
  rawText: string,
  chapterRef: string,
): ElementExtractionResult {
  const parsed = safeParseJson(rawText)

  const result: ElementExtractionResult = {
    characters: [],
    locations: [],
    entities: [],
    timeline: [],
    plots: [],
    worldbuilding: [],
  }

  if (!parsed || typeof parsed !== 'object') {
    return result
  }

  for (const bucket of Object.keys(result) as ExtractionBucket[]) {
    const rawItems = (parsed as Record<string, unknown>)[bucket]
    const type = BUCKET_TYPE_MAP[bucket]

    if (!Array.isArray(rawItems)) {
      continue
    }

    for (const raw of rawItems) {
      const item = toExtractionItem(raw, type, chapterRef)
      if (item) {
        result[bucket].push(item)
      }
    }
  }

  return result
}

function safeParseJson(text: string): unknown {
  const trimmed = text.trim()

  // 优先尝试直接解析
  const direct = tryJson(trimmed)
  if (direct !== undefined) {
    return direct
  }

  // 回退：提取 ```json ... ``` 代码块
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const inner = tryJson(fenced[1].trim())
    if (inner !== undefined) {
      return inner
    }
  }

  // 再回退：截取第一个 { 到最后一个 } 之间的内容
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const slice = trimmed.slice(start, end + 1)
    const sliced = tryJson(slice)
    if (sliced !== undefined) {
      return sliced
    }
  }

  return null
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function toExtractionItem(
  raw: unknown,
  type: ElementType,
  chapterRef: string,
): ElementExtractionItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''

  if (!name) {
    return null
  }

  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const body = typeof record.body === 'string' ? record.body.trim() : ''

  return {
    type,
    name,
    summary: summary || `${name} 在「${chapterRef}」中出现。`,
    tags: ['AI 提取', typeToTag(type)],
    lastUpdatedChapter: chapterRef,
    relatedChapters: [chapterRef],
    body: body || `${name} 需要后续整理。`,
  }
}

function typeToTag(type: ElementType): string {
  switch (type) {
    case 'character': return '人物'
    case 'location': return '地点'
    case 'entity': return '实体'
    case 'timeline': return '时间线'
    case 'plot': return '情节'
    case 'worldbuilding': return '设定'
  }
}
