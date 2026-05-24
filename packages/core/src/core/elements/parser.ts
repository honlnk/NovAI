import type { ElementDocument, ElementFrontmatter } from '../../types/elements'

export function parseElementFile(sourcePath: string, content: string): ElementDocument {
  const { frontmatter, body } = splitFrontmatter(content)

  return {
    sourcePath,
    frontmatter: normalizeFrontmatter(frontmatter),
    body: body.trim(),
  }
}

function splitFrontmatter(content: string) {
  const normalized = content.replace(/\r\n/g, '\n')

  if (!normalized.startsWith('---\n')) {
    return {
      frontmatter: '',
      body: normalized,
    }
  }

  const endIndex = normalized.indexOf('\n---\n', 4)

  if (endIndex === -1) {
    return {
      frontmatter: '',
      body: normalized,
    }
  }

  return {
    frontmatter: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 5),
  }
}

function normalizeFrontmatter(raw: string): ElementFrontmatter {
  const lines = raw.split('\n')
  const record: Record<string, string> = {}
  let currentListKey = ''

  for (const sourceLine of lines) {
    const line = sourceLine.trim()

    if (!line) {
      continue
    }

    if (line.startsWith('- ') && currentListKey) {
      record[currentListKey] = `${record[currentListKey] ?? ''}, ${line.slice(2).trim()}`.trim()
      continue
    }

    const separatorIndex = line.indexOf(':')

    if (separatorIndex === -1) {
      currentListKey = ''
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    record[key] = value
    currentListKey = value ? '' : key
  }

  return {
    id: record.id ?? '',
    type: normalizeType(record.type),
    name: record.name ?? '',
    summary: record.summary ?? '',
    tags: splitList(record.tags),
    lastUpdatedChapter: record.lastUpdatedChapter ?? record.last_updated_chapter ?? '',
    relatedChapters: splitList(record.relatedChapters ?? record.related_chapters),
    updatedAt: record.updatedAt ?? record.updated_at ?? '',
  }
}

function normalizeType(value: string | undefined): ElementFrontmatter['type'] {
  if (value === 'location' || value === 'timeline' || value === 'plot' || value === 'worldbuilding') {
    return value
  }

  return 'character'
}

function splitList(value: string | undefined) {
  return (value ?? '')
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
