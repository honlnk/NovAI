import { diffChars, diffLines } from 'diff'

/**
 * 正文版本冲突的差异呈现（修复批 2026-11-20，替代 text-diff.ts 在冲突界面的角色）：
 * 小说正文一段一行，旧的「整行完全相等」LCS 会把段内改一词放大成整段删除＋新增，
 * 双栏空白占位又进一步放大错位。本模块改用 jsdiff 组织差异：
 *
 * - 行对齐用 diffLines（maxEditLength 预算保护超长文本）；中止即明确降级为整块
 *   红/绿对比，不伪装成精确 diff；
 * - 差异组织为单栏块：未改动上下文（每处变更前后各 CONTEXT 行）、更长未改动区
 *   折叠（携带隐藏行，UI 可展开）、变更块为上下相邻的「原段落（红）／新段落（绿）」；
 * - 配对段落内部用 diffChars 做字级高亮（INLINE_MAX_EDIT 预算，超限整段红绿呈现），
 *   少量中文润色只突出实际变化的字；
 * - 纯增段绿显、纯删段红显；空文本、空行按普通行处理。
 *
 * text-diff.ts 保持原样（WriteConfirmPanel 仍在用，属确认面板范围）。
 * 只提供整版本比较：不做逐段采纳、冲突标记编辑或自动三方合并。
 */

/** 配对段落内部的字符级变换段（两侧共用一个变换：旧段渲染 same/del，新段渲染 same/add） */
export type InlineDiffSegment = {
  kind: 'same' | 'del' | 'add'
  text: string
}

/** 一处修改 = 上下相邻的原段落（红）×新段落（绿）；单侧存在即纯删/纯增段 */
export type ConflictDiffChangePair = {
  /** 原段落（仅草稿有）；undefined = 纯新增段 */
  old?: string
  /** 新段落（仅磁盘有）；undefined = 纯删除段 */
  new?: string
  /** old→new 的字符级变换（null = 变换超预算或单侧段落，整段红绿呈现） */
  inline: InlineDiffSegment[] | null
}

export type ConflictDiffBlock =
  /** 未改动上下文（含展开后的折叠区），灰显 */
  | { kind: 'context'; lines: string[] }
  /** 折叠的未改动区（携带隐藏行与稳定 id，供 UI 展开渲染） */
  | { kind: 'fold'; id: number; count: number; lines: string[] }
  /** 一处修改：一组上下相邻的原/新段落对 */
  | { kind: 'change'; pairs: ConflictDiffChangePair[] }

export type ConflictDiffResult = {
  /** true = 差异过大已降级：不做逐段对齐，整块红绿对比（UI 必须明示） */
  degraded: boolean
  blocks: ConflictDiffBlock[]
  stats: { changed: number; added: number; removed: number }
  /** 降级整块对比的截断信息（两侧各自隐藏的行数；未截断为 0） */
  truncated: { left: number; right: number }
}

/** 行级 diff 预算（编辑步数）：超出即降级。实测章节规模冲突（600 行改 30 段）1ms 内完成 */
const LINE_DIFF_MAX_EDIT = 5_000
/** 行级 diff 墙钟预算（ms）：与编辑预算双保险，病态输入按时间中止（返回 undefined） */
const LINE_DIFF_TIMEOUT_MS = 500
/** 配对段落的字符级 diff 预算：超限整段红绿呈现，不做字级高亮 */
const INLINE_MAX_EDIT = 300
/** 每处修改前后的上下文行数 */
const CONTEXT_LINES = 3
/** 间隔不超过此行数的未改动区不折叠（3+3 上下文 + 2 行余量） */
const NO_FOLD_GAP = CONTEXT_LINES * 2 + 2
/** 降级整块对比的两侧各自展示行数上限 */
const DEGRADED_PREVIEW_LINES = 400

type DiffRun = { equal: string[] } | { removed: string[]; added: string[] }

/** jsdiff 的 part.value → 行数组（行尾换行不单独成行；与 DiffLines.vue 同口径） */
function partToLines(value: string): string[] {
  return value.replace(/\n$/, '').split('\n')
}

/** 配对段落的字符级变换；超预算返回 null（整段红绿，不伪装精确） */
function inlineSegments(old: string, next: string): InlineDiffSegment[] | null {
  if (old === next) {
    return [{ kind: 'same', text: old }]
  }
  const parts = diffChars(old, next, { maxEditLength: INLINE_MAX_EDIT })
  if (!parts) {
    return null
  }
  const segments: InlineDiffSegment[] = []
  for (const part of parts) {
    if (part.value === '') continue
    segments.push({ kind: part.added ? 'add' : part.removed ? 'del' : 'same', text: part.value })
  }
  return segments.length > 0 ? segments : null
}

/** 相等行区 → 上下文 + 折叠块（position 决定保留头/尾上下文） */
function pushEqualRun(
  blocks: ConflictDiffBlock[],
  lines: string[],
  position: 'leading' | 'middle' | 'trailing',
  nextFoldId: () => number,
): void {
  if (lines.length === 0) {
    return
  }
  if (lines.length <= NO_FOLD_GAP) {
    blocks.push({ kind: 'context', lines })
    return
  }
  const head = lines.slice(0, CONTEXT_LINES)
  const tail = lines.slice(lines.length - CONTEXT_LINES)
  const hidden = lines.slice(CONTEXT_LINES, lines.length - CONTEXT_LINES)
  if (position === 'leading') {
    // 文首无上文：折叠开头（含 head），只保留进入第一处修改前的 tail 上下文
    blocks.push({ kind: 'fold', id: nextFoldId(), count: lines.length - tail.length, lines: [...head, ...hidden] })
    blocks.push({ kind: 'context', lines: tail })
    return
  }
  if (position === 'trailing') {
    blocks.push({ kind: 'context', lines: head })
    blocks.push({ kind: 'fold', id: nextFoldId(), count: lines.length - head.length, lines: [...hidden, ...tail] })
    return
  }
  blocks.push({ kind: 'context', lines: head })
  blocks.push({ kind: 'fold', id: nextFoldId(), count: hidden.length, lines: hidden })
  blocks.push({ kind: 'context', lines: tail })
}

/** 一组删除/新增行 → 相邻段落对（按位置配对；双侧段落做字级变换） */
function buildChangePairs(removed: string[], added: string[]): ConflictDiffChangePair[] {
  const pairs: ConflictDiffChangePair[] = []
  const count = Math.max(removed.length, added.length)
  for (let i = 0; i < count; i += 1) {
    const old = i < removed.length ? removed[i] : undefined
    const next = i < added.length ? added[i] : undefined
    pairs.push({
      ...(old !== undefined ? { old } : {}),
      ...(next !== undefined ? { new: next } : {}),
      inline: old !== undefined && next !== undefined ? inlineSegments(old, next) : null,
    })
  }
  return pairs
}

/** diffLines 的 part 流 →（相等行区 / 变更组）交替序列（相邻同型合并） */
function partFlowToRuns(parts: ReturnType<typeof diffLines>): DiffRun[] {
  const runs: DiffRun[] = []
  let pendingRemoved: string[] = []
  let pendingAdded: string[] = []
  const flushChange = () => {
    if (pendingRemoved.length > 0 || pendingAdded.length > 0) {
      runs.push({ removed: pendingRemoved, added: pendingAdded })
      pendingRemoved = []
      pendingAdded = []
    }
  }
  for (const part of parts) {
    if (part.added) {
      pendingAdded.push(...partToLines(part.value))
    } else if (part.removed) {
      pendingRemoved.push(...partToLines(part.value))
    } else {
      flushChange()
      const lines = partToLines(part.value)
      const last = runs[runs.length - 1]
      if (last && 'equal' in last) {
        last.equal.push(...lines)
      } else {
        runs.push({ equal: lines })
      }
    }
  }
  flushChange()
  return runs
}

/** 差异过大降级：两侧整块红绿对比（各截取前 DEGRADED_PREVIEW_LINES 行），不做逐段对齐 */
function buildDegradedResult(left: string, right: string): ConflictDiffResult {
  const leftLines = left === '' ? [] : left.split('\n')
  const rightLines = right === '' ? [] : right.split('\n')
  const pairs: ConflictDiffChangePair[] = []
  for (const line of leftLines.slice(0, DEGRADED_PREVIEW_LINES)) {
    pairs.push({ old: line, inline: null })
  }
  for (const line of rightLines.slice(0, DEGRADED_PREVIEW_LINES)) {
    pairs.push({ new: line, inline: null })
  }
  return {
    degraded: true,
    blocks: [{ kind: 'change', pairs }],
    stats: { changed: 0, added: rightLines.length, removed: leftLines.length },
    truncated: {
      left: Math.max(0, leftLines.length - DEGRADED_PREVIEW_LINES),
      right: Math.max(0, rightLines.length - DEGRADED_PREVIEW_LINES),
    },
  }
}

/**
 * 组织两个版本的差异块序列。left = 人工草稿，right = 磁盘（AI 修改后）。
 * 两侧文本完全一致时返回空变更（stats 全零），由调用方按「无差异」呈现。
 */
export function buildConflictDiff(left: string, right: string): ConflictDiffResult {
  const parts = diffLines(left, right, {
    maxEditLength: LINE_DIFF_MAX_EDIT,
    timeout: LINE_DIFF_TIMEOUT_MS,
  })
  if (!parts) {
    return buildDegradedResult(left, right)
  }

  const runs = partFlowToRuns(parts)
  const blocks: ConflictDiffBlock[] = []
  const stats = { changed: 0, added: 0, removed: 0 }
  let foldSeq = 0
  const nextFoldId = () => foldSeq++

  // 相等区位置：第一处修改之前 = leading，最后一处修改之后 = trailing，其间 = middle
  let lastChangeIndex = -1
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if ('removed' in runs[i]!) {
      lastChangeIndex = i
      break
    }
  }

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!
    if ('removed' in run) {
      const pairs = buildChangePairs(run.removed, run.added)
      for (const pair of pairs) {
        if (pair.old !== undefined && pair.new !== undefined) stats.changed += 1
        else if (pair.new !== undefined) stats.added += 1
        else stats.removed += 1
      }
      blocks.push({ kind: 'change', pairs })
    } else {
      const position = i < lastChangeIndex ? (i === 0 ? 'leading' : 'middle') : 'trailing'
      pushEqualRun(blocks, run.equal, position, nextFoldId)
    }
  }

  return { degraded: false, blocks, stats, truncated: { left: 0, right: 0 } }
}
