import { parseElementFile } from './parser'
import { readProjectFile } from '../fs/project-fs'
import { hashContent } from '../util/hash'

import type { ProjectSnapshot, TreeNode } from '../../types/project'
import type { ElementCatalogEntry } from '../../types/elements'
import type { ElementType } from '../../types/rag'

/**
 * 要素目录扫描与 digest（渐进式披露 L1，决策 0007）。
 *
 * 四类稳定要素（characters/locations/entities/worldbuilding）走「目录 reminder +
 * LoadElements 按需加载」；plots/timeline 留在 RAG 通道（收窄见 indexer）。
 */

/** 目录覆盖的四类要素目录：类型顺序即目录分组的展示顺序。 */
const CATALOG_ELEMENT_DIRECTORIES: readonly { dir: string; type: ElementType }[] = [
  { dir: 'elements/characters/', type: 'character' },
  { dir: 'elements/locations/', type: 'location' },
  { dir: 'elements/entities/', type: 'entity' },
  { dir: 'elements/worldbuilding/', type: 'worldbuilding' },
]

/**
 * 扫描四类要素目录，产出目录条目。读 frontmatter 需逐文件读取（async），
 * 单个文件读取/解析失败时跳过该条（一个坏文件不阻塞整个会话）。
 */
export async function scanElementCatalog(project: ProjectSnapshot): Promise<ElementCatalogEntry[]> {
  const paths = collectCatalogPaths(project.tree)
  const entries: ElementCatalogEntry[] = []

  for (const path of paths) {
    try {
      const file = await readProjectFile(project, path)
      const parsed = parseElementFile(path, file.content)
      const name = parsed.frontmatter.name.trim() || inferNameFromPath(path)
      entries.push({
        type: parsed.frontmatter.type,
        name,
        // summary 缺失用 name 兜底：保持要素在目录中可见（确定性召回优先于文案完整）
        summary: parsed.frontmatter.summary.trim() || name,
        sourcePath: path,
      })
    } catch {
      continue
    }
  }

  return sortCatalogEntries(entries)
}

/**
 * 目录 digest：对条目数组（name + summary）算 hash，照 dsh digestCatalogEntries 的做法——
 * 每条 JSON.stringify 保证边界精确，join 拼接后整体 hash。
 *
 * 敏感面 = 条目数量、name、summary；不敏感面 = 文件正文、sourcePath、mtime、
 * 以及同一批条目的枚举顺序（hash 前先归一排序）。目录只放稳定信息（决策 0007 决策二），
 * 版本标记类字段一概不进 digest。
 */
export function digestElementCatalog(entries: readonly ElementCatalogEntry[]): string {
  const canonical = sortCatalogEntries([...entries])
    .map((entry) => JSON.stringify([entry.name, entry.summary]))
    .join('\n')
  return hashContent(canonical)
}

/** 树内收集四类目录下的 .md 路径（plots/timeline 及其他目录一概不收）。 */
function collectCatalogPaths(tree: TreeNode[]): string[] {
  const paths: string[] = []
  const stack = [...tree]

  while (stack.length > 0) {
    const node = stack.shift()
    if (!node) {
      continue
    }

    if (node.kind === 'file' && node.name.endsWith('.md') && isCatalogPath(node.path)) {
      paths.push(node.path)
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return paths
}

function isCatalogPath(path: string): boolean {
  return CATALOG_ELEMENT_DIRECTORIES.some(({ dir }) => path.startsWith(dir))
}

/** 稳定排序：类型分组序 + name 序。枚举顺序归一，保证 digest 与目录渲染都不抖动。 */
function sortCatalogEntries(entries: ElementCatalogEntry[]): ElementCatalogEntry[] {
  const typeOrder = new Map(CATALOG_ELEMENT_DIRECTORIES.map(({ type }, index) => [type, index]))
  return [...entries].sort((a, b) => {
    const typeDiff = (typeOrder.get(a.type) ?? 0) - (typeOrder.get(b.type) ?? 0)
    if (typeDiff !== 0) {
      return typeDiff
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

function inferNameFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? '未命名要素'
}
