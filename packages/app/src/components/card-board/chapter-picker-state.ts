/**
 * 章节选择器纯状态逻辑（作者字段控制权计划阶段 1）。
 *
 * 与 ChapterPicker.vue 配套的可测纯函数：高亮移动、多选标签操作、新建表单校验、
 * 引用解析结果的展示文案。组件只做响应式接线，行为规则集中在这里，
 * 由 chapter-picker-state.test.ts 覆盖（键盘、多选、重排、消歧等规则）。
 */
import { resolveChapterReference } from '@novai/core/services/chapter-service'
import type {
  ChapterCatalog,
  ChapterCatalogEntry,
  ChapterRefResolution,
} from '@novai/core/types/chapters'

/** 新建章节的执行结果（由接线层 useChapterCatalog 产出，组件经 createHandler 注入）。 */
export type ChapterCreateOutcome =
  | { kind: 'created'; entry: ChapterCatalogEntry }
  | { kind: 'number-taken'; existing: ChapterCatalogEntry[] }
  | { kind: 'invalid-number'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'stale' }

/** 新建章节执行器：组件不直接落盘，由接线层提供（含跨项目晚到守卫）。 */
export type ChapterCreateHandler = (input: { chapterNumber: number; title: string | null }) => Promise<ChapterCreateOutcome>

/**
 * 键盘高亮移动：上下键在可见选项间循环；null 起点「下」落到首项、「上」落到末项。
 * 没有可选项时保持 null。
 */
export function nextHighlightIndex(
  current: number | null,
  optionCount: number,
  delta: 1 | -1,
): number | null {
  if (optionCount <= 0) {
    return null
  }

  if (current === null) {
    return delta === 1 ? 0 : optionCount - 1
  }

  return (current + delta + optionCount) % optionCount
}

/** 多选追加：保留全部既有项与顺序；重复引用不重复添加（保存端去重保首次位置）。 */
export function appendUniqueValue(values: readonly string[], ref: string): string[] {
  return values.includes(ref) ? [...values] : [...values, ref]
}

/** 多选删除指定位置。 */
export function removeValueAt(values: readonly string[], index: number): string[] {
  return values.filter((_, position) => position !== index)
}

/** 多选重排：与相邻项交换，边界不动（不产生新顺序）。 */
export function moveValueAt(values: readonly string[], index: number, delta: 1 | -1): string[] {
  const target = index + delta
  if (index < 0 || index >= values.length || target < 0 || target >= values.length) {
    return [...values]
  }

  const next = [...values]
  const current = next[index]!
  next[index] = next[target]!
  next[target] = current
  return next
}

/** 新建表单校验：章号必须是正整数；标题去空白，空则按「未命名」由服务端处理。 */
export function validateCreateForm(
  numberText: string,
  title: string,
): { ok: true; chapterNumber: number; title: string | null } | { ok: false; error: string } {
  const trimmedNumber = numberText.trim()

  if (!/^\d+$/u.test(trimmedNumber)) {
    return { ok: false, error: '章号必须是正整数' }
  }

  const chapterNumber = Number(trimmedNumber)
  if (chapterNumber < 1) {
    return { ok: false, error: '章号必须是正整数' }
  }

  return { ok: true, chapterNumber, title: title.trim() === '' ? null : title.trim() }
}

/** 展示徽标：只对需要作者注意的解析状态返回文案（正常命中与空值不标注）。 */
export type ChapterBadge = {
  label: string
  tone: 'warn' | 'danger'
}

export function badgeForResolution(resolution: ChapterRefResolution): ChapterBadge | null {
  switch (resolution.kind) {
    case 'unset':
      return null
    case 'missing':
      return resolution.number === null
        ? { label: '该章号当前没有章节', tone: 'warn' }
        : { label: `第${resolution.number}章当前没有章节`, tone: 'warn' }
    case 'chapter':
      return resolution.uncertainIdentity
        ? { label: '按章号位置恢复展示，无法确认是否原章节', tone: 'warn' }
        : null
    case 'ambiguous':
      return { label: '章号重复，待消歧', tone: 'danger' }
    case 'unparseable':
      return { label: '原文无法解析为章节引用', tone: 'danger' }
  }
}

/** 已选值主文案：目录未就绪或解析不出条目时退回原始引用，保证已选项可显示。 */
export function displayForResolution(resolution: ChapterRefResolution, rawRef: string | null | undefined): string {
  if (resolution.kind === 'unset') {
    return '未设置'
  }

  if (resolution.kind === 'chapter') {
    const { entry } = resolution
    const prefix = entry.directory ? `${entry.directory}/` : ''
    return `${prefix}第${String(entry.number).padStart(3, '0')}章 ${entry.title}`
  }

  return rawRef ?? ''
}

/** 统一入口：目录就绪时解析引用并给出（主文案 + 徽标），未就绪时只显示原文。 */
export function describeChapterValue(
  catalog: ChapterCatalog,
  catalogReady: boolean,
  ref: string | null | undefined,
): { text: string; badge: ChapterBadge | null } {
  if (!catalogReady) {
    return { text: ref?.trim() === '' || ref === null || ref === undefined ? '未设置' : ref, badge: null }
  }

  const resolution = resolveChapterReference(catalog, ref)
  return {
    text: displayForResolution(resolution, ref),
    badge: badgeForResolution(resolution),
  }
}
