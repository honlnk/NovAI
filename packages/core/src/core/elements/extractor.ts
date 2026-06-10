import type { ElementExtractionResult } from '../../types/elements'
import type { ElementType } from '../../types/rag'

type ExtractionBucket = keyof ElementExtractionResult

const TYPE_BUCKET_MAP: Record<ElementType, ExtractionBucket> = {
  character: 'characters',
  location: 'locations',
  entity: 'entities',
  timeline: 'timeline',
  plot: 'plots',
  worldbuilding: 'worldbuilding',
}

const LOCATION_SUFFIXES = '楼阁院城镇村谷山峰林河湖海洞宫殿寺庙塔桥巷街路关岛洲府国界域'
const ENTITY_SUFFIX_PATTERN =
  '令牌|玉佩|丹药|卷轴|图谱|秘籍|功法|剑法|刀法|拳法|掌法|身法|秘术|法器|灵器|宝物|信物|剑|刀|枪|戟|弓|弩|鞭|锤|鼎|炉|镜|珠|佩|钗|戒|袍|甲|冠|印|符|丸|散|膏|酒|茶|马|兽|鹰|书'

export async function extractElementsFromChapter(input: {
  chapterContent: string
  chapterPath?: string
  systemPrompt?: string
}): Promise<ElementExtractionResult> {
  const content = normalizeChapterContent(input.chapterContent)
  const title = extractTitle(content, input.chapterPath)
  const chapterRef = input.chapterPath || title
  const result: ElementExtractionResult = {
    characters: [],
    locations: [],
    entities: [],
    timeline: [],
    plots: [],
    worldbuilding: [],
  }

  for (const name of extractCharacterNames(content)) {
    pushItem(result, 'character', {
      name,
      summary: `${name} 在「${title}」中出现，需要记录其当前状态与关系变化。`,
      tags: ['自动提取', '人物'],
      lastUpdatedChapter: chapterRef,
      relatedChapters: [chapterRef],
      body: buildBody(content, name, '人物线索'),
    })
  }

  for (const name of extractLocationNames(content)) {
    pushItem(result, 'location', {
      name,
      summary: `${name} 是「${title}」中出现的地点或场景。`,
      tags: ['自动提取', '地点'],
      lastUpdatedChapter: chapterRef,
      relatedChapters: [chapterRef],
      body: buildBody(content, name, '地点线索'),
    })
  }

  for (const name of extractEntityNames(content)) {
    pushItem(result, 'entity', {
      name,
      summary: `${name} 是「${title}」中出现的具体实体，需要记录来历、归属、能力或状态变化。`,
      tags: ['自动提取', '实体'],
      lastUpdatedChapter: chapterRef,
      relatedChapters: [chapterRef],
      body: buildEntityBody(content, name),
    })
  }

  const plotSummary = summarizeChapter(content)
  if (plotSummary) {
    pushItem(result, 'plot', {
      name: title,
      summary: plotSummary,
      tags: ['自动提取', '情节'],
      lastUpdatedChapter: chapterRef,
      relatedChapters: [chapterRef],
      body: `## 情节摘要\n\n${plotSummary}\n\n## 原文线索\n\n${excerpt(content)}`,
    })
  }

  pushItem(result, 'timeline', {
    name: `${title} 时间线`,
    summary: `记录「${title}」中的事件顺序与状态变化。`,
    tags: ['自动提取', '时间线'],
    lastUpdatedChapter: chapterRef,
    relatedChapters: [chapterRef],
    body: buildTimelineBody(content),
  })

  for (const name of extractWorldbuildingNames(content)) {
    pushItem(result, 'worldbuilding', {
      name,
      summary: `${name} 是「${title}」中出现的设定、物件或组织线索。`,
      tags: ['自动提取', '设定'],
      lastUpdatedChapter: chapterRef,
      relatedChapters: [chapterRef],
      body: buildBody(content, name, '设定线索'),
    })
  }

  return result
}

function pushItem(
  result: ElementExtractionResult,
  type: ElementType,
  item: Omit<ElementExtractionResult[ExtractionBucket][number], 'type'>,
) {
  const bucket = result[TYPE_BUCKET_MAP[type]]

  if (bucket.some((existing) => existing.name === item.name)) {
    return
  }

  bucket.push({
    type,
    ...item,
  })
}

function normalizeChapterContent(content: string) {
  return content.replace(/\r\n/g, '\n').trim()
}

function extractTitle(content: string, chapterPath?: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()

  if (heading) {
    return heading
  }

  const fileName = chapterPath?.split('/').pop()?.replace(/\.(md|txt)$/i, '').trim()
  return fileName || '未命名章节'
}

function extractCharacterNames(markdown: string) {
  const names = new Set<string>()
  const patterns = [
    /(?:主角|人物|少年|少女|男人|女人|老人|修士|侍卫|掌柜|先生|姑娘|公子)([一-龥]{2,4})(?:在|于|向|对|和|与|说|道|问|答|，|。)/g,
    /(?:主角|人物|少年|少女|男人|女人|老人|修士|侍卫|掌柜|先生|姑娘|公子)([一-龥]{2,4})/g,
    /(?:^|[。！？!?；;\n])([一-龥]{2,4})(?:说|道|问|答|低声|喃喃|皱眉|抬头|回头|沉默|笑了|走进|发现|看见)/g,
    /「([^」]{2,4})」(?:说|道|问|答)/g,
  ]

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const name = sanitizeName(match[1])

      if (isLikelyName(name)) {
        names.add(name)
      }
    }
  }

  return Array.from(names).slice(0, 8)
}

function extractLocationNames(markdown: string) {
  const names = new Set<string>()
  const patterns = [
    new RegExp(`([一-龥]{2,8}[${LOCATION_SUFFIXES}])`, 'g'),
    /(?:走进|进入|来到|抵达|离开|穿过|回到|前往)([一-龥]{2,10})/g,
  ]

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const name = sanitizeName(match[1])

      if (name.length >= 2 && name.length <= 10 && !isCommonPhrase(name)) {
        names.add(name)
      }
    }
  }

  return Array.from(names).slice(0, 8)
}

function extractWorldbuildingNames(markdown: string) {
  const names = new Set<string>()
  const pattern = /([一-龥]{2,10}(?:契约|阵法|禁制|传说|预言|组织|宗门|王朝|仪式|门派|规矩|境界|体系))/g

  for (const match of markdown.matchAll(pattern)) {
    const name = sanitizeName(match[1])

    if (name.length >= 2 && !isCommonPhrase(name)) {
      names.add(name)
    }
  }

  return Array.from(names).slice(0, 8)
}

function extractEntityNames(markdown: string) {
  const names = new Set<string>()
  const patterns = [
    new RegExp(`([一-龥]{2,12}(?:${ENTITY_SUFFIX_PATTERN}))`, 'g'),
    /(?:持有|握住|拔出|取出|递给|服下|修炼|施展|得到|遗失|损毁)([一-龥]{2,12})/g,
  ]

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const name = sanitizeName(match[1])

      if (name.length >= 2 && name.length <= 12 && !isCommonPhrase(name)) {
        names.add(name)
      }
    }
  }

  return Array.from(names).slice(0, 8)
}

function summarizeChapter(markdown: string) {
  const paragraph = markdown
    .split(/\n{2,}/)
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find((item) => item.length >= 20)

  return paragraph ? trimText(paragraph, 140) : ''
}

function buildBody(markdown: string, name: string, heading: string) {
  return [
    `## ${heading}`,
    '',
    collectEvidence(markdown, name),
    '',
    '## 待补充',
    '',
    '- 当前状态：待人工或 Agent 继续整理。',
    '- 与其他要素的关系：待补充。',
  ].join('\n')
}

function buildEntityBody(markdown: string, name: string) {
  return [
    '## 基本信息',
    '',
    '- 类型：待补充',
    '- 当前状态：待补充',
    '',
    '## 实体线索',
    '',
    collectEvidence(markdown, name),
    '',
    '## 来历与归属',
    '',
    '- 来历：待补充。',
    '- 当前归属：待补充。',
    '',
    '## 能力或用途',
    '',
    '- 待补充。',
    '',
    '## 状态变化',
    '',
    '- 待补充。',
  ].join('\n')
}

function buildTimelineBody(markdown: string) {
  const sentences = splitSentences(markdown)
    .filter((sentence) => sentence.length >= 8)
    .slice(0, 6)

  if (sentences.length === 0) {
    return '## 事件顺序\n\n- 待补充。'
  }

  return [
    '## 事件顺序',
    '',
    ...sentences.map((sentence) => `- ${trimText(sentence, 90)}`),
  ].join('\n')
}

function collectEvidence(markdown: string, keyword: string) {
  const sentences = splitSentences(markdown)
    .filter((sentence) => sentence.includes(keyword))
    .slice(0, 4)

  if (sentences.length === 0) {
    return `- 自动提取到「${keyword}」，但暂未截取到明确上下文。`
  }

  return sentences.map((sentence) => `- ${trimText(sentence, 100)}`).join('\n')
}

function splitSentences(markdown: string) {
  return markdown
    .replace(/^#+\s+.+$/gm, '')
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function excerpt(markdown: string) {
  return trimText(markdown.replace(/^#+\s+.+$/gm, '').trim(), 500)
}

function sanitizeName(value: string) {
  return value
    .replace(/[，。！？、,.!?：:“”"'《》（）()【】\[\]\s]/g, '')
    .trim()
}

function isLikelyName(value: string) {
  return value.length >= 2 && value.length <= 4 && !isCommonPhrase(value)
}

function isCommonPhrase(value: string) {
  const common = new Set([
    '他们',
    '我们',
    '你们',
    '这里',
    '那里',
    '这个',
    '那个',
    '什么',
    '时候',
    '已经',
    '没有',
    '发现',
    '看见',
    '听见',
    '深夜',
    '废弃',
    '来自',
    '年前',
  ])

  return common.has(value)
}

function trimText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
