import type { ElementDocument, ElementExtractionItem, ElementWriteResult } from '../../types/elements'
import type { ElementType } from '../../types/rag'

import { writeProjectTextFile } from '../fs/project-fs'

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
  }

  for (const element of elements) {
    const directory = ELEMENT_DIRECTORY_MAP[element.frontmatter.type]
    const fileName = `${slugifyElementName(element.frontmatter.name || element.frontmatter.id || 'element')}.md`
    const path = `${directory}/${fileName}`

    await writeProjectTextFile(rootHandle, path, stringifyElementDocument(element))
    result.updated.push(path)
  }

  return result
}

export function createElementDocument(item: ElementExtractionItem): ElementDocument {
  return {
    sourcePath: '',
    frontmatter: {
      id: '',
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
    `id: ${element.frontmatter.id}`,
    `type: ${element.frontmatter.type}`,
    `name: ${element.frontmatter.name}`,
    `summary: ${element.frontmatter.summary}`,
    `tags: ${element.frontmatter.tags.join(', ')}`,
    `lastUpdatedChapter: ${element.frontmatter.lastUpdatedChapter}`,
    `relatedChapters: ${element.frontmatter.relatedChapters.join(', ')}`,
    `updatedAt: ${element.frontmatter.updatedAt}`,
  ]

  return `---\n${frontmatterLines.join('\n')}\n---\n\n${element.body}\n`
}

function slugifyElementName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_一-龥]/g, '')
}
