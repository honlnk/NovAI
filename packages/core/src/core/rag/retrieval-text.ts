import type { ElementDocument } from '../../types/elements'

const MAX_TAGS = 10
const MAX_RELATED_CHAPTERS = 20

const TYPE_LABELS = {
  character: '人物',
  location: '地点',
  timeline: '时间线',
  plot: '情节',
  worldbuilding: '世界观',
} as const

export function buildRetrievalText(element: ElementDocument) {
  const lines = [
    formatLine('类型', TYPE_LABELS[element.frontmatter.type]),
    formatLine('名称', element.frontmatter.name),
    formatLine('摘要', element.frontmatter.summary),
    formatLine('标签', element.frontmatter.tags.slice(0, MAX_TAGS).join('、')),
    formatLine('最后更新章节', element.frontmatter.lastUpdatedChapter),
    formatLine('相关章节', element.frontmatter.relatedChapters.slice(0, MAX_RELATED_CHAPTERS).join('、')),
  ].filter(Boolean)

  if (element.body.trim()) {
    lines.push('', '正文：', element.body.trim())
  }

  return lines.join('\n')
}

function formatLine(label: string, value: string) {
  const normalizedValue = value.trim()
  return normalizedValue ? `${label}：${normalizedValue}` : ''
}
