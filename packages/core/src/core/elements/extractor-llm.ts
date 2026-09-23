import { streamChatCompletion } from '../llm/client'

import { getElementBodyTemplate } from './templates'

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

export function buildExtractionSystemPrompt(): string {
  return [
    '你是小说创作要素抽取助手。你的任务是从单章正文中识别并结构化抽取六类要素。',
    '',
    '【六类要素定义】',
    '- characters：登场人物，记录姓名、当前状态、关键行为。',
    '- locations：出现的地点、场景、场所。',
    '- entities：具体实体，包括武功、武器、坐骑、丹药、信物、法器等。',
    '- timeline：本章关键事件的时间顺序节点。',
    '- plots：本章核心情节事件，必须按独立事件拆分——一个事件一个条目，禁止输出「本章剧情」「剧情总纲」这类笼统条目。',
    '- worldbuilding：涉及的设定、规则、体系、组织、境界等抽象世界观线索。',
    '',
    buildTemplateInstructions(),
    '',
    '【输出要求】',
    '- 只输出一个 JSON 对象，不要输出任何解释、前言、注释或代码块标记。',
    '- JSON 顶层包含六个数组字段：characters、locations、entities、timeline、plots、worldbuilding。',
    '- 每个元素是一个对象，字段：name（字符串，必填）、summary（简短描述）、body（按上述模板分节的详细说明）、tags（可选）。',
    '- timeline 条目必须在 body 的「所属阶段」中给出阶段名（如 缘起 / 幼年 / 收徒），并在「故事内时间」中给出故事内时间。',
    '- tags 为字符串数组，2~5 个概括性标签（如 主角、反派、信物），不要包含类型名本身；不确定可省略。',
    '- 没有对应要素的类别返回空数组。',
    '- 不要编造正文中没有的要素；只抽取本章实际出现的内容。',
    '- 全部使用中文。',
    '',
    '【输出 JSON 结构示例】',
    '{"characters":[{"name":"示例人物","summary":"本章做了什么","body":"## 基本信息\\n- **首次登场**：第001章\\n...","tags":["主角","少年"]}],"locations":[],"entities":[],"timeline":[],"plots":[],"worldbuilding":[]}',
  ].join('\n')
}

function buildTemplateInstructions(): string {
  const templatedBuckets: Array<{ bucket: ExtractionBucket; type: ElementType }> = [
    { bucket: 'characters', type: 'character' },
    { bucket: 'locations', type: 'location' },
    { bucket: 'entities', type: 'entity' },
    { bucket: 'timeline', type: 'timeline' },
    { bucket: 'plots', type: 'plot' },
  ]

  const lines: string[] = [
    '【body 分节模板】',
    '除 worldbuilding 外，每个条目的 body 必须严格按对应模板的分节输出；正文没有涉及的小节填「待补充」，不要省略节标题。',
    '',
  ]

  for (const { bucket, type } of templatedBuckets) {
    const template = getElementBodyTemplate(type)

    if (template) {
      lines.push(`${bucket} 模板：`, template.trimEnd(), '')
    }
  }

  lines.push('worldbuilding 不设模板，body 不限结构，写清规则内容即可。')

  return lines.join('\n')
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
    tags: mergeTags(type, record.tags),
    lastUpdatedChapter: chapterRef,
    relatedChapters: [chapterRef],
    body: body || `${name} 需要后续整理。`,
  }
}

/**
 * 合并兜底标记与模型产出的 tags。模型 tags 只接受 string 数组，逐项 trim、
 * 去空、去重；字段缺失或非法时回退为仅兜底两枚。
 */
function mergeTags(type: ElementType, raw: unknown): string[] {
  const baseTags = ['AI 提取', typeToTag(type)]

  if (!Array.isArray(raw)) {
    return baseTags
  }

  const modelTags: string[] = []

  for (const item of raw) {
    if (typeof item !== 'string') {
      continue
    }

    const tag = item.trim()

    if (tag && !modelTags.includes(tag)) {
      modelTags.push(tag)
    }
  }

  return [...new Set([...baseTags, ...modelTags])]
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
