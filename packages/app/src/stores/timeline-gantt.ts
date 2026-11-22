/**
 * 时间轴甘特视图排布（时间轴甘特图改造计划 §四）：纯函数，不依赖 DOM。
 *
 * - 横轴 = 列表顺序：第 i 个时间标记（point/start/end 都算）占第 i 列，与真实时间无关；
 * - 行与事件不绑定：横向不重叠的条目可共用一行；多行都能放时选条目最少的行（均匀分配）；
 * - 行数封顶 6，放不下就加宽列宽重排；区间嵌套深度本身超过 6 时上限放宽到该深度；
 *   列宽加到 480 仍失败则以不限行数完成，保证必然终止；
 * - 表头按列显示世界观日期（明确时间），不显示列序号；日期比列宽时同样加宽列宽，
 *   保证相邻两列的日期互不重叠、首列日期不被左缘截断；同一日期连续出现时每列都写；
 * - 同一输入必得同一输出（确定性），筛选命中态不参与排布（筛选时图不跳动）。
 *
 * 文字测宽经参数注入：组件侧用 canvas measureText，单测注入固定字宽。
 */

/** 排布输入：每个携带详情的标记（point / start）一条；end 只贡献区间右端列号 */
export type GanttEntry = {
  eventId: string
  kind: 'point' | 'span'
  title: string
  /** 明确时间展示文字（无则空串）：显示在表头本列位置；相对时间不上图 */
  dateLabel: string
  startIndex: number
  /** 点事件等于 startIndex */
  endIndex: number
  matched: boolean
}

export type GanttLayoutItem = GanttEntry & {
  row: number
  /** 起始列中心 x */
  x: number
  /** 区间横条左右缘（点事件为菱形左右缘） */
  barLeft: number
  barRight: number
  /** 占位范围（含越出横条的文字），排布判重叠用 */
  left: number
  right: number
}

/** 表头日期标签：落在事件起始列中心（文字居中） */
export type GanttHeaderLabel = {
  index: number
  text: string
  x: number
  width: number
}

export type GanttLayout = {
  items: GanttLayoutItem[]
  labels: GanttHeaderLabel[]
  rowCount: number
  /** 实际列宽（≥ minStep） */
  step: number
  /** 内容总宽（含左右留白） */
  width: number
}

export type GanttMeasure = (text: string, fontSize: number) => number

export const GANTT_MAX_ROWS = 6
export const GANTT_MAX_STEP = 480
export const GANTT_STEP_INCREMENT = 8
export const GANTT_TITLE_FONT = 12
/** 表头日期字号 */
export const GANTT_DATE_FONT = 11
export const GANTT_PAD_X = 24

const ITEM_GAP = 12
/** 表头相邻两个日期之间的最小留白 */
const HEADER_GAP = 10
/** 首个日期左缘距内容左边的最小距离 */
const HEADER_EDGE = 4
const POINT_HALF = 7
const POINT_TEXT_GAP = 6
const BAR_PAD = 8

export function ganttColumnX(index: number, step: number): number {
  return GANTT_PAD_X + index * step + step / 2
}

/** 条目文字宽：只有标题（日期写在表头，不跟在标题后） */
export function ganttTextWidth(entry: Pick<GanttEntry, 'title'>, measure: GanttMeasure): number {
  return measure(entry.title, GANTT_TITLE_FONT)
}

/** 表头日期在给定列宽下不重叠、不被左缘截断所需的最小列宽（无日期为 0） */
export function ganttHeaderMinStep(labels: ReadonlyArray<{ index: number; width: number }>): number {
  let required = 0
  const first = labels[0]
  if (first) {
    // 左缘 = PAD + i·step + step/2 − w/2 ≥ HEADER_EDGE
    required = Math.max(required, (first.width / 2 + HEADER_EDGE - GANTT_PAD_X) / (first.index + 0.5))
  }
  for (let position = 1; position < labels.length; position += 1) {
    const previous = labels[position - 1]!
    const current = labels[position]!
    const columns = current.index - previous.index
    required = Math.max(required, ((previous.width + current.width) / 2 + HEADER_GAP) / columns)
  }
  return required
}

/** 同一列上「覆盖该列的区间数 + 该列是否有点事件」的最大值（与列宽无关的行数下界） */
export function ganttOverlapDepth(entries: readonly GanttEntry[], columnCount: number): number {
  let depth = 0
  for (let column = 0; column < columnCount; column += 1) {
    let count = 0
    for (const entry of entries) {
      if (entry.startIndex <= column && column <= entry.endIndex) {
        count += 1
      }
    }
    depth = Math.max(depth, count)
  }
  return depth
}

function placeItems(entries: readonly GanttEntry[], step: number, textWidths: readonly number[]): GanttLayoutItem[] {
  return entries.map((entry, index) => {
    const x = ganttColumnX(entry.startIndex, step)
    const textWidth = textWidths[index]!
    if (entry.kind === 'point') {
      return {
        ...entry,
        row: -1,
        x,
        barLeft: x - POINT_HALF,
        barRight: x + POINT_HALF,
        left: x - POINT_HALF,
        right: x + POINT_HALF + POINT_TEXT_GAP + textWidth,
      }
    }
    const barLeft = x - BAR_PAD
    const barRight = ganttColumnX(entry.endIndex, step) + BAR_PAD
    return {
      ...entry,
      row: -1,
      x,
      barLeft,
      barRight,
      left: barLeft,
      right: Math.max(barRight, barLeft + BAR_PAD + textWidth + BAR_PAD),
    }
  })
}

/** 按 left 升序逐个放行；超过行数上限返回 null */
function packRows(items: GanttLayoutItem[], maxRows: number): number | null {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.left - b.item.left || a.item.startIndex - b.item.startIndex || a.index - b.index)
  const rowRight: number[] = []
  const rowCount: number[] = []
  for (const { item } of order) {
    let best = -1
    for (let row = 0; row < rowRight.length; row += 1) {
      if (rowRight[row]! + ITEM_GAP > item.left) {
        continue
      }
      if (
        best === -1
        || rowCount[row]! < rowCount[best]!
        || (rowCount[row] === rowCount[best] && rowRight[row]! < rowRight[best]!)
      ) {
        best = row
      }
    }
    if (best === -1) {
      if (rowRight.length >= maxRows) {
        return null
      }
      rowRight.push(Number.NEGATIVE_INFINITY)
      rowCount.push(0)
      best = rowRight.length - 1
    }
    item.row = best
    rowRight[best] = item.right
    rowCount[best] = rowCount[best]! + 1
  }
  return rowRight.length
}

export function layoutTimelineGantt(
  entries: readonly GanttEntry[],
  columnCount: number,
  options: { minStep: number; measure: GanttMeasure },
): GanttLayout {
  const requestedStep = Math.max(1, options.minStep)
  if (entries.length === 0) {
    return { items: [], labels: [], rowCount: 0, step: requestedStep, width: GANTT_PAD_X * 2 + columnCount * requestedStep }
  }

  const textWidths = entries.map((entry) => ganttTextWidth(entry, options.measure))
  const headerLabels = entries
    .filter((entry) => entry.dateLabel)
    .map((entry) => ({ index: entry.startIndex, text: entry.dateLabel, width: options.measure(entry.dateLabel, GANTT_DATE_FONT) }))
    .sort((left, right) => left.index - right.index)
  // 表头日期放得下是硬约束：起步列宽直接抬到所需值（不受 6 行规则影响）
  const minStep = Math.max(requestedStep, Math.ceil(ganttHeaderMinStep(headerLabels)))
  const maxRows = Math.max(GANTT_MAX_ROWS, ganttOverlapDepth(entries, columnCount))
  const maxStep = Math.max(GANTT_MAX_STEP, minStep)

  const finish = (items: GanttLayoutItem[], rowCount: number, step: number): GanttLayout => {
    const labels = headerLabels.map((label) => ({ ...label, x: ganttColumnX(label.index, step) }))
    const contentRight = items.reduce((max, item) => Math.max(max, item.right), 0)
    const labelRight = labels.reduce((max, label) => Math.max(max, label.x + label.width / 2), 0)
    const gridRight = GANTT_PAD_X + columnCount * step
    return { items, labels, rowCount, step, width: Math.ceil(Math.max(contentRight, labelRight, gridRight) + GANTT_PAD_X) }
  }

  for (let step = minStep; step <= maxStep; step += GANTT_STEP_INCREMENT) {
    const items = placeItems(entries, step, textWidths)
    const rowCount = packRows(items, maxRows)
    if (rowCount !== null) {
      return finish(items, rowCount, step)
    }
  }

  // 列宽封顶仍排不进：不限行数完成（必然终止）
  const items = placeItems(entries, maxStep, textWidths)
  const rowCount = packRows(items, Number.POSITIVE_INFINITY)!
  return finish(items, rowCount, maxStep)
}
