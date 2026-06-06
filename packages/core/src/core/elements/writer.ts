import type { ElementDocument, ElementExtractionItem, ElementWriteResult } from '../../types/elements'
import type { ElementType } from '../../types/rag'

import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'

const ELEMENT_DIRECTORY_MAP: Record<ElementType, string> = {
  character: 'elements/characters',
  location: 'elements/locations',
  timeline: 'elements/timeline',
  plot: 'elements/plots',
  worldbuilding: 'elements/worldbuilding',
}

export async function writeElementDocuments(
  rootHandle: FileSystemDirectoryHandle,
  elements: ElementDocument[],
): Promise<ElementWriteResult> {
  const result: ElementWriteResult = {
    created: [],
    updated: [],
    skipped: [],
    staleIndex: false,
  }

  for (const element of elements) {
    const directory = ELEMENT_DIRECTORY_MAP[element.frontmatter.type]
    const id = element.frontmatter.id || createElementId(element)
    const fileName = `${slugifyElementName(element.frontmatter.name || id)}.md`
    const path = `${directory}/${fileName}`
    const nextDocument: ElementDocument = {
      ...element,
      sourcePath: path,
      frontmatter: {
        ...element.frontmatter,
        id,
        updatedAt: new Date().toISOString(),
      },
    }
    const content = stringifyElementDocument(nextDocument)
    const existing = await readExisting(rootHandle, path)

    if (existing !== null && normalizeForComparison(existing) === normalizeForComparison(content)) {
      result.skipped.push(path)
      continue
    }

    await writeProjectTextFile(rootHandle, path, content)

    if (existing === null) {
      result.created.push(path)
    } else {
      result.updated.push(path)
    }
  }

  result.staleIndex = result.created.length > 0 || result.updated.length > 0
  return result
}

export function createElementDocument(item: ElementExtractionItem): ElementDocument {
  return {
    sourcePath: '',
    frontmatter: {
      id: createElementIdFromItem(item),
      type: item.type,
      name: item.name,
      summary: item.summary,
      tags: item.tags,
      lastUpdatedChapter: item.lastUpdatedChapter,
      relatedChapters: item.relatedChapters,
      updatedAt: new Date().toISOString(),
    },
    body: item.body.trim(),
  }
}

function stringifyElementDocument(element: ElementDocument) {
  const frontmatterLines = [
    `id: ${escapeFrontmatterValue(element.frontmatter.id)}`,
    `type: ${escapeFrontmatterValue(element.frontmatter.type)}`,
    `name: ${escapeFrontmatterValue(element.frontmatter.name)}`,
    `summary: ${escapeFrontmatterValue(element.frontmatter.summary)}`,
    `tags: ${element.frontmatter.tags.map(escapeFrontmatterValue).join(', ')}`,
    `lastUpdatedChapter: ${escapeFrontmatterValue(element.frontmatter.lastUpdatedChapter)}`,
    `relatedChapters: ${element.frontmatter.relatedChapters.map(escapeFrontmatterValue).join(', ')}`,
    `updatedAt: ${escapeFrontmatterValue(element.frontmatter.updatedAt)}`,
  ]

  return `---\n${frontmatterLines.join('\n')}\n---\n\n${element.body}\n`
}

async function readExisting(rootHandle: FileSystemDirectoryHandle, path: string) {
  try {
    return await readProjectTextFile(rootHandle, path)
  } catch {
    return null
  }
}

function createElementId(element: ElementDocument) {
  return createElementIdFromItem({
    type: element.frontmatter.type,
    name: element.frontmatter.name,
    summary: element.frontmatter.summary,
    tags: element.frontmatter.tags,
    lastUpdatedChapter: element.frontmatter.lastUpdatedChapter,
    relatedChapters: element.frontmatter.relatedChapters,
    body: element.body,
  })
}

function createElementIdFromItem(item: ElementExtractionItem) {
  return `${item.type}-${slugifyElementName(item.name || 'element')}`
}

function slugifyElementName(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_一-龥]/g, '')

  return slug || 'element'
}

function escapeFrontmatterValue(value: string) {
  return value.replace(/\n/g, ' ').trim()
}

function normalizeForComparison(content: string) {
  return content
    .replace(/^updatedAt: .*$/m, 'updatedAt: <ignored>')
    .trim()
}
