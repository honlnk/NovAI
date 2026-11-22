/**
 * 两个文本版本的行级对比（数据安全计划 §3-6「版本比较与选择」）：
 * 人工保存遇到 AI 已写盘的冲突时，并列查看「我的草稿」与「磁盘（AI 修改后）」，
 * 以红（仅草稿有——采纳磁盘时会丢）/ 绿（仅磁盘有——AI 的修改）呈现差异。
 *
 * 只提供整版本比较：不做逐段采纳、冲突标记编辑或自动三方合并（计划明确不做）。
 * 先裁掉公共前后缀再对中段做 LCS 动态规划；中段规模超限时退化为整块对比
 * （不逐行对齐，保证超长正文不卡界面）。
 */

export type LineDiffRow =
  | { kind: 'equal'; text: string }
  /** 仅左侧（草稿）有的行：红 */
  | { kind: 'left'; text: string }
  /** 仅右侧（磁盘）有的行：绿 */
  | { kind: 'right'; text: string }

/** LCS 中段规模上限（n*m 超过即退化整块对比）；2000×2000 行以内逐行对齐 */
const LCS_CELL_BUDGET = 4_000_000

/** 退化模式下的最大展示行数（两侧各展示的行数上限，其余折叠提示） */
const FALLBACK_PREVIEW_LINES = 400

export function buildLineDiffRows(left: string, right: string): LineDiffRow[] {
  // 完全空的文本没有行（''.split('\n') 会产生一个伪空行）
  const leftLines = left === '' ? [] : left.split('\n')
  const rightLines = right === '' ? [] : right.split('\n')

  // 公共前缀
  let start = 0
  while (
    start < leftLines.length
    && start < rightLines.length
    && leftLines[start] === rightLines[start]
  ) {
    start += 1
  }
  // 公共后缀
  let endLeft = leftLines.length
  let endRight = rightLines.length
  while (endLeft > start && endRight > start && leftLines[endLeft - 1] === rightLines[endRight - 1]) {
    endLeft -= 1
    endRight -= 1
  }

  const rows: LineDiffRow[] = []
  for (let i = 0; i < start; i += 1) {
    rows.push({ kind: 'equal', text: leftLines[i]! })
  }

  const midLeft = leftLines.slice(start, endLeft)
  const midRight = rightLines.slice(start, endRight)
  rows.push(...diffMiddle(midLeft, midRight))

  for (let i = endLeft; i < leftLines.length; i += 1) {
    rows.push({ kind: 'equal', text: leftLines[i]! })
  }
  return rows
}

function diffMiddle(left: string[], right: string[]): LineDiffRow[] {
  if (left.length === 0 && right.length === 0) {
    return []
  }
  if (left.length * right.length > LCS_CELL_BUDGET) {
    return buildFallbackRows(left, right)
  }

  // LCS 长度表（滚动行）：dpRows[i-1][j] = left 前 i 行与 right 前 j 行的 LCS 长度
  // 第 0 行（left 空串）恒为全零，直接以 Int32Array 占位
  let prev = new Int32Array(right.length + 1)
  const dpRows: Int32Array[] = []
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Int32Array(right.length + 1)
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j]!, current[j - 1]!)
    }
    dpRows.push(current)
    prev = current
  }
  /** dp 访问器：dp(0, j) = dp(i, 0) = 0；dp(i, j) = dpRows[i-1][j] */
  const dp = (i: number, j: number): number =>
    (i === 0 || j === 0) ? 0 : dpRows[i - 1]![j]!

  // 回溯路径（从末尾走回开头，输出后反转）
  const rows: LineDiffRow[] = []
  let i = left.length
  let j = right.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      rows.push({ kind: 'equal', text: left[i - 1]! })
      i -= 1
      j -= 1
      continue
    }
    if (j > 0 && (i === 0 || dp(i - 1, j) >= dp(i, j - 1))) {
      rows.push({ kind: 'right', text: right[j - 1]! })
      j -= 1
      continue
    }
    rows.push({ kind: 'left', text: left[i - 1]! })
    i -= 1
  }
  rows.reverse()
  return rows
}

/** 超规模退化：两侧整块对比（红块 + 绿块相邻呈现），各截取前 400 行并提示折叠 */
function buildFallbackRows(left: string[], right: string[]): LineDiffRow[] {
  const rows: LineDiffRow[] = []
  const pushSide = (kind: 'left' | 'right', lines: string[]) => {
    const limit = Math.min(lines.length, FALLBACK_PREVIEW_LINES)
    for (let i = 0; i < limit; i += 1) {
      rows.push({ kind, text: lines[i]! })
    }
    if (lines.length > limit) {
      rows.push({ kind, text: `……（其余 ${lines.length - limit} 行已折叠，差异过大不做逐行对齐）` })
    }
  }
  if (left.length > 0) {
    pushSide('left', left)
  }
  if (right.length > 0) {
    pushSide('right', right)
  }
  return rows
}

/** 差异统计（冲突界面顶部说明用） */
export function countLineDiff(left: string, right: string): { onlyLeft: number; onlyRight: number } {
  const rows = buildLineDiffRows(left, right)
  let onlyLeft = 0
  let onlyRight = 0
  for (const row of rows) {
    if (row.kind === 'left') onlyLeft += 1
    if (row.kind === 'right') onlyRight += 1
  }
  return { onlyLeft, onlyRight }
}
