/**
 * 章节目录纯函数（作者字段控制权计划阶段 1）：从项目文件树构建章节目录、
 * 解析既有章节引用（旧值核对）、按选择器规则过滤。
 *
 * 全部纯函数、无 fs 访问——章节引用按「全本章号位置」解释，不引入稳定章节
 * 身份；重复章号保留全部候选并标记待消歧，不自动选择或改绑（计划 §三.4）。
 */
import { CHAPTER_NAME_PATTERN, CHAPTER_NUMBER_PATTERN, parseChapterNumber } from '../tools/chapter-name'
import type {
  ChapterCatalog,
  ChapterCatalogEntry,
  ChapterRefResolution,
} from '../../types/chapters'

/**
 * 目录构建入参的最小结构：TreeNode（core）与 ProjectFileNodeView（services 视图）
 * 都满足该形状，目录构建不关心额外字段。
 */
export type ChapterTreeSourceNode = {
  kind: 'file' | 'directory'
  name: string
  path: string
  children?: readonly ChapterTreeSourceNode[]
}

/** 由章节文件节点组装目录条目；directory 为相对 chapters/ 的目录（根为 ''）。 */
function toEntry(node: ChapterTreeSourceNode, directory: string): ChapterCatalogEntry | null {
  const number = parseChapterNumber(node.name)
  if (number === null) {
    return null
  }

  const strict = CHAPTER_NAME_PATTERN.exec(node.name)
  const directoryPrefix = directory ? `${directory}/` : ''

  return {
    number,
    title: strict ? strict[2]! : node.name.replace(/\.txt$/u, ''),
    fileName: node.name,
    directory,
    path: node.path,
    ref: `${directoryPrefix}${node.name.replace(/\.txt$/u, '')}`,
    canonical: strict !== null,
  }
}

/** 递归遍历 chapters/ 目录，收集章节条目（不收集无「第N章」片段的文件）。 */
function collectEntries(nodes: readonly ChapterTreeSourceNode[], directory: string, output: ChapterCatalogEntry[]): void {
  for (const node of nodes) {
    if (node.kind === 'file') {
      const entry = toEntry(node, directory)
      if (entry) {
        output.push(entry)
      }
    } else if (node.children?.length) {
      const nextDirectory = directory ? `${directory}/${node.name}` : node.name
      collectEntries(node.children, nextDirectory, output)
    }
  }
}

/**
 * 从项目文件树（顶层含 chapters/ 目录节点）构建章节目录。
 * 目录不存在时返回空目录（无章节），不抛错。
 */
export function buildChapterCatalog(nodes: readonly ChapterTreeSourceNode[]): ChapterCatalog {
  const chaptersNode = nodes.find(node => node.kind === 'directory' && node.path === 'chapters')
  const entries: ChapterCatalogEntry[] = []

  if (chaptersNode?.children?.length) {
    collectEntries(chaptersNode.children, '', entries)
  }

  entries.sort((a, b) => (a.number - b.number) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const byNumber = new Map<number, ChapterCatalogEntry[]>()
  for (const entry of entries) {
    const bucket = byNumber.get(entry.number)
    if (bucket) {
      bucket.push(entry)
    } else {
      byNumber.set(entry.number, [entry])
    }
  }

  const duplicateNumbers = new Set<number>()
  for (const [number, bucket] of byNumber) {
    if (bucket.length > 1) {
      duplicateNumbers.add(number)
    }
  }

  return {
    entries,
    duplicateNumbers,
    maxNumber: entries.length > 0 ? entries[entries.length - 1]!.number : null,
  }
}

/** 引用末段是否携带标题片段（「第N章-标题」形态；仅「第N章」则没有）。 */
function refTitleFragment(ref: string): string | null {
  const lastSegment = ref.slice(ref.lastIndexOf('/') + 1)
  const match = /^第\d+章-(.+)$/u.exec(lastSegment)
  return match ? match[1]! : null
}

/**
 * 解析既有章节引用（旧值核对）：
 * - unset：空值；
 * - chapter：章号唯一命中。引用自带卷或标题与当前条目不一致时 uncertainIdentity
 *   置真（按章号位置恢复展示，无法确认是否原章节——删后同号重建与改名同形）；
 * - missing：能解析出章号但当前没有该章（「该章号当前没有章节」）；
 * - ambiguous：章号命中多个候选（历史重号，待消歧，不自动选择）；
 * - unparseable：解析不出章号的自由文本（兼容原文，不作正常章节匹配依据）。
 */
export function resolveChapterReference(
  catalog: ChapterCatalog,
  ref: string | null | undefined,
): ChapterRefResolution {
  if (ref === null || ref === undefined || ref.trim() === '') {
    return { kind: 'unset' }
  }

  const trimmed = ref.trim()
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const number = parseChapterNumber(lastSegment)
  if (number === null) {
    return { kind: 'unparseable', raw: ref }
  }

  const matches = catalog.entries.filter(entry => entry.number === number)
  if (matches.length === 0) {
    return { kind: 'missing', number }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', entries: matches }
  }

  const entry = matches[0]!
  const refDirectory = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : ''
  const refTitle = refTitleFragment(trimmed)
  const uncertainIdentity = (refDirectory !== '' && refDirectory !== entry.directory)
    || (refTitle !== null && refTitle !== entry.title)

  return { kind: 'chapter', entry, uncertainIdentity }
}

/**
 * 选择器搜索过滤（计划 §三.4）：数字查询按全本章号等值匹配（不把章号拆成
 * 别的层级）；非数字查询按标题、目录、引用形态的子串匹配（大小写不敏感）。
 */
export function filterChapterEntries(
  entries: readonly ChapterCatalogEntry[],
  query: string,
): ChapterCatalogEntry[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return [...entries]
  }

  if (/^\d+$/u.test(trimmed)) {
    const number = Number(trimmed)
    return entries.filter(entry => entry.number === number)
  }

  const lowered = trimmed.toLowerCase()
  return entries.filter(entry =>
    entry.title.toLowerCase().includes(lowered)
    || entry.directory.toLowerCase().includes(lowered)
    || entry.ref.toLowerCase().includes(lowered),
  )
}

/** 建议的下一个章号：当前最大章号 + 1（无章节时 1）。 */
export function suggestNextChapterNumber(catalog: ChapterCatalog): number {
  return (catalog.maxNumber ?? 0) + 1
}

/** 新建章节文件名的编号补零宽度：与既有最大章号同宽，至少 3 位。 */
export function chapterNumberPadWidth(catalog: ChapterCatalog): number {
  return Math.max(3, String(catalog.maxNumber ?? 0).length)
}
