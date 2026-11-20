import { parseElementFile } from './parser'
import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'

import type { ProjectSnapshot, TreeNode } from '../../types/project'
import type { ElementType } from '../../types/rag'

/**
 * 稳定引用索引（关系图谱阶段 1 公共地基，供关系账本与后续时间线事件账本复用）。
 *
 * 现有要素文档的 frontmatter `id` 是半成品（缺失兜底空串、无唯一性校验，会话链路
 * 实际以 name 定位）。本模块补齐「标识 → 类型、名称、摘要、路径」的确定性解析：
 * 重复标识报告 issue 不静默合并；缺失标识由领域在首次引用时懒分配（ensureElementId）；
 * 改名走纯文件移动不重写 frontmatter，已有引用天然不受影响。
 */

/** 引用索引覆盖的六类要素目录（比目录披露宽：plots/timeline 也参与解析，供领域自行取舍）。 */
const REFERENCE_ELEMENT_DIRECTORIES: readonly { dir: string; type: ElementType }[] = [
  { dir: 'elements/characters/', type: 'character' },
  { dir: 'elements/locations/', type: 'location' },
  { dir: 'elements/entities/', type: 'entity' },
  { dir: 'elements/plots/', type: 'plot' },
  { dir: 'elements/timeline/', type: 'timeline' },
  { dir: 'elements/worldbuilding/', type: 'worldbuilding' },
]

/** 路径是否落在要素目录内（删除要素级联清理关系账本用）。 */
export function isElementSourcePath(path: string): boolean {
  return REFERENCE_ELEMENT_DIRECTORIES.some(({ dir }) => path.startsWith(dir))
}

export type ElementReferenceEntry = {
  /** frontmatter id；未分配时为空串（等待领域懒分配）。 */
  id: string
  type: ElementType
  name: string
  summary: string
  sourcePath: string
}

export type ElementReferenceIssue =
  | { kind: 'duplicate-id'; id: string; sourcePaths: string[] }
  | { kind: 'unreadable-file'; sourcePath: string; reason: string }

export type ElementReferenceIndex = {
  entries: ElementReferenceEntry[]
  issues: ElementReferenceIssue[]
}

/**
 * 扫描六类要素目录构建引用索引。逐文件读取解析 frontmatter；单个文件读取失败
 * 进 issues（不阻塞整个索引）；重复非空 id 报 issue 且条目全部保留（不静默合并）。
 */
export async function buildElementReferenceIndex(project: ProjectSnapshot): Promise<ElementReferenceIndex> {
  const paths = collectReferencePaths(project.tree)
  const entries: ElementReferenceEntry[] = []
  const issues: ElementReferenceIssue[] = []

  for (const path of paths) {
    try {
      const content = await readProjectTextFile(project.handle, path)
      const parsed = parseElementFile(path, content)
      entries.push({
        id: parsed.frontmatter.id.trim(),
        type: parsed.frontmatter.type,
        name: parsed.frontmatter.name.trim() || inferNameFromPath(path),
        summary: parsed.frontmatter.summary.trim(),
        sourcePath: path,
      })
    } catch (error) {
      issues.push({
        kind: 'unreadable-file',
        sourcePath: path,
        reason: error instanceof Error ? error.message : '读取失败',
      })
    }
  }

  // 重复 id 检测：同 id 的全部条目保留展示，引用解析按 ambiguous 处理
  const byId = new Map<string, ElementReferenceEntry[]>()
  for (const entry of entries) {
    if (!entry.id) {
      continue
    }
    const group = byId.get(entry.id) ?? []
    group.push(entry)
    byId.set(entry.id, group)
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      issues.push({ kind: 'duplicate-id', id, sourcePaths: group.map((entry) => entry.sourcePath).sort() })
    }
  }

  return { entries: sortReferenceEntries(entries), issues }
}

export type ElementIdResolution =
  | { status: 'resolved'; entry: ElementReferenceEntry }
  | { status: 'missing'; id: string }
  | { status: 'ambiguous'; id: string; sourcePaths: string[] }

/** 按稳定标识解析要素：resolved / missing / ambiguous（重复 id 不猜、不合并）。 */
export function resolveElementById(index: ElementReferenceIndex, id: string): ElementIdResolution {
  const matches = index.entries.filter((entry) => entry.id === id)

  if (matches.length === 0) {
    return { status: 'missing', id }
  }

  if (matches.length > 1) {
    return { status: 'ambiguous', id, sourcePaths: matches.map((entry) => entry.sourcePath).sort() }
  }

  return { status: 'resolved', entry: matches[0] }
}

/** 按名称子串搜索（引用选择器用）：可选类型过滤，保持索引排序。 */
export function searchElementEntries(
  index: ElementReferenceIndex,
  query: string,
  type?: ElementType,
): ElementReferenceEntry[] {
  const needle = query.trim().toLowerCase()
  return index.entries.filter((entry) => {
    if (type && entry.type !== type) {
      return false
    }
    return !needle || entry.name.toLowerCase().includes(needle)
  })
}

/** 领域分配的要素标识格式：ELM- + 10 位小写字母数字。读取侧不做格式强校验（人工维护的既有 id 原样保留）。 */
export const ELEMENT_ID_PATTERN = /^ELM-[0-9a-z]{10}$/

export function generateElementId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let out = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(10)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      out += alphabet[byte % alphabet.length]
    }
  } else {
    for (let index = 0; index < 10; index += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
  }
  return `ELM-${out}`
}

/**
 * 确保要素文件具有稳定标识：已有非空 id 原样返回（assigned=false，含人工维护的
 * 非 ELM 格式 id——不静默改写既有数据）；缺失或为空时生成并写回 frontmatter。
 * 只增改 `id` 一行，正文与其余 frontmatter 字段原样保留；原文件为 CRLF 时写回保持 CRLF。
 */
export async function ensureElementId(
  project: ProjectSnapshot,
  sourcePath: string,
): Promise<{ id: string; assigned: boolean }> {
  const original = await readProjectTextFile(project.handle, sourcePath)
  const parsed = parseElementFile(sourcePath, original)
  const existing = parsed.frontmatter.id.trim()

  if (existing) {
    return { id: existing, assigned: false }
  }

  const id = generateElementId()
  const normalized = original.replace(/\r\n/g, '\n')
  const next = insertIdLine(normalized, id)
  const output = original.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next

  await writeProjectTextFile(project.handle, sourcePath, output)
  return { id, assigned: true }
}

/** 在 frontmatter 顶部插入或补全 id 行（normalized 为 LF 文本）。 */
function insertIdLine(normalized: string, id: string): string {
  const idLine = `id: ${id}`

  if (!normalized.startsWith('---\n')) {
    return `---\n${idLine}\n---\n${normalized}`
  }

  const endIndex = normalized.indexOf('\n---\n', 4)

  if (endIndex === -1) {
    // 有开头无闭合：frontmatter 块不完整，按无 frontmatter 处理（补一个完整块）
    return `---\n${idLine}\n---\n${normalized}`
  }

  const frontmatter = normalized.slice(4, endIndex)
  const rest = normalized.slice(endIndex)

  // 已有空值 id 行（`id:` 后为空）：原位补全
  const emptyIdLine = /^id:[ \t]*$/m
  if (emptyIdLine.test(frontmatter)) {
    return `---\n${frontmatter.replace(emptyIdLine, idLine)}${rest}`
  }

  return `---\n${frontmatter === '' ? idLine : `${idLine}\n${frontmatter}`}${rest}`
}

/** 树内收集六类目录下的 .md 路径（含嵌套子目录；其他目录与根级 JSON 一概不收）。 */
function collectReferencePaths(tree: TreeNode[]): string[] {
  const paths: string[] = []
  const stack = [...tree]

  while (stack.length > 0) {
    const node = stack.shift()
    if (!node) {
      continue
    }

    if (node.kind === 'file' && node.name.endsWith('.md') && isReferencePath(node.path)) {
      paths.push(node.path)
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return paths
}

function isReferencePath(path: string): boolean {
  return REFERENCE_ELEMENT_DIRECTORIES.some(({ dir }) => path.startsWith(dir))
}

/** 稳定排序：类型分组序 + name 序。 */
function sortReferenceEntries(entries: ElementReferenceEntry[]): ElementReferenceEntry[] {
  const typeOrder = new Map(REFERENCE_ELEMENT_DIRECTORIES.map(({ type }, index) => [type, index]))
  return [...entries].sort((left, right) => {
    const typeDiff = (typeOrder.get(left.type) ?? 0) - (typeOrder.get(right.type) ?? 0)
    if (typeDiff !== 0) {
      return typeDiff
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
}

function inferNameFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? '未命名要素'
}
