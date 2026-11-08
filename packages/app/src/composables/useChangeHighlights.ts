import { reactive } from 'vue'

import type { FileChangeRange } from '@novai/core'

/**
 * 定位高亮反馈队列（交互优化计划 §7）：AI 写盘成功后，在内容面板中定位真实修改、
 * 以绿（新内容）/红（被替换的原文，仅用于比较、不写盘）呈现，多处修改逐处切换，
 * 不同文件形成通知队列不互相覆盖。
 *
 * 结构（照抄 useFileDrafts 的模块级状态模式）：
 * - 状态按项目隔离存模块级 Map（ProjectView 与 FilePanelBody 共享同一份响应式状态）；
 * - 通知（ChangeNotice）：不抢现场时的可点击反馈位（正在编辑/有草稿/在看别的文件/
 *   后台会话改动），点击后由 ProjectView 打开文件并重播稳定差异；
 * - 任务（ChangeHighlightJob）：当前正在面板中呈现的一次高亮，同一时刻至多一个
 *   （面板一次只显示一个文件）；timed 模式 2.5 秒稳定后 1.2 秒淡出，settled 后保留
 *   「重新查看本轮差异」入口；stable 模式（重播）不自动淡出，由用户关闭。
 *
 * 减少动态效果（prefers-reduced-motion）：取消平滑滚动与淡出——timed 任务保持稳定
 * 显示直到被替换或关闭，滚动由调用方改用即时跳转。
 */

/** 稳定显示时长（ms，§7「约 2.5 秒」） */
export const HIGHLIGHT_STABLE_MS = 2500
/** 淡出时长（ms，§7「约 1.2 秒」） */
export const HIGHLIGHT_FADE_MS = 1200
/** 通知队列上限：长任务防堆积，最老的先出 */
export const MAX_CHANGE_NOTICES = 20

/** 通知里携带的可定位信息（点击「查看差异」时重播用）；无坐标的旧记录缺省 */
export type NoticeLocatePayload = {
  ranges: FileChangeRange[]
  oldText: string
  /** 写盘后版本的内容哈希；重播前校验面板内容仍是该版本，失配降级不伪造高亮 */
  afterHash?: string
}

/** 不抢现场时的可点击变更通知（反馈队列的一条） */
export type ChangeNotice = {
  recordId: string
  path: string
  fileName: string
  status: 'created' | 'updated'
  /** 修改处数（coords.ranges 数；无坐标时 1） */
  count: number
  /** 有定位坐标才可「查看差异」；否则只能「查看文件」 */
  canLocate: boolean
  /** 重播所需的定位载荷（canLocate 时存在） */
  locate?: NoticeLocatePayload
  /**
   * 来源会话归属（F10）：后台会话的改动标注会话标题，让用户知道是谁改的；
   * 当前激活会话的改动不标（上下文自明）。创建时的快照，不随后续切换更新。
   */
  sessionId?: string
  sessionTitle?: string
}

export type ChangeHighlightJob = {
  recordId: string
  path: string
  ranges: FileChangeRange[]
  oldText: string
  /** 当前呈现第几处（0-based，逐处切换游标） */
  cursor: number
  /** timed = 自动播放（稳定→淡出）；stable = 重播（不自动淡出） */
  mode: 'timed' | 'stable'
  /** show = 差异可见；fading = 淡出过渡中；settled = 已淡出（保留重播入口） */
  phase: 'show' | 'fading' | 'settled'
}

type ProjectHighlightState = {
  notices: ChangeNotice[]
  job: ChangeHighlightJob | null
}

const statesByProject = new Map<string, ProjectHighlightState>()
const timersByProject = new Map<string, { stable?: ReturnType<typeof setTimeout>; fade?: ReturnType<typeof setTimeout> }>()

function getState(projectId: string): ProjectHighlightState {
  let state = statesByProject.get(projectId)
  if (!state) {
    state = reactive<ProjectHighlightState>({ notices: [], job: null })
    statesByProject.set(projectId, state)
  }
  return state
}

function clearTimers(projectId: string) {
  const timers = timersByProject.get(projectId)
  if (timers?.stable) clearTimeout(timers.stable)
  if (timers?.fade) clearTimeout(timers.fade)
  timersByProject.delete(projectId)
}

/** 减少动态效果偏好（§7.5）：取消平滑滚动与淡出，显示稳定差异 */
export function prefersReducedMotion(): boolean {
  return reducedMotionProbe()
}

/** 探针可注入（单测环境无 window）；生产探针读 prefers-reduced-motion 媒体查询 */
let reducedMotionProbe: () => boolean = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 测试注入口：替换减少动态效果探针；传 null 恢复默认 */
export function _setReducedMotionProbe(probe: (() => boolean) | null): void {
  reducedMotionProbe = probe ?? (() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

export type StartJobParams = {
  recordId: string
  path: string
  ranges: FileChangeRange[]
  oldText: string
  mode: 'timed' | 'stable'
}

/**
 * 开始呈现一次高亮（自动播放或重播共用）。同一时刻至多一个任务：
 * 新任务替换旧任务（旧任务的通知仍留在队列里等用户处理）；同名通知视为已查看出队。
 */
export function startHighlightJob(projectId: string, params: StartJobParams): void {
  const state = getState(projectId)
  clearTimers(projectId)
  state.job = { ...params, cursor: 0, phase: 'show' }
  dismissChangeNotice(projectId, params.recordId)

  if (params.mode !== 'timed') {
    return
  }
  // 减少动态效果：不淡出，保持稳定显示（直到被替换或手动关闭）
  if (prefersReducedMotion()) {
    return
  }
  const timers: { stable?: ReturnType<typeof setTimeout>; fade?: ReturnType<typeof setTimeout> } = {}
  timersByProject.set(projectId, timers)
  timers.stable = setTimeout(() => {
    // 期间任务被替换/关闭：不再推进
    if (getState(projectId).job?.recordId !== params.recordId) return
    getState(projectId).job!.phase = 'fading'
    timers.fade = setTimeout(() => {
      const job = getState(projectId).job
      if (job?.recordId !== params.recordId) return
      job.phase = 'settled'
    }, HIGHLIGHT_FADE_MS)
  }, HIGHLIGHT_STABLE_MS)
}

/** 逐处切换（§7.3）：游标循环移动（最后一处的下一处回到第一处） */
export function advanceHighlightCursor(projectId: string, delta: number): void {
  const job = getState(projectId).job
  if (!job || job.ranges.length === 0) return
  const count = job.ranges.length
  job.cursor = (((job.cursor + delta) % count) + count) % count
}

/** 「重新查看本轮差异」：以稳定模式重播当前任务（不自动淡出，由用户关闭） */
export function replayHighlightJob(projectId: string): void {
  const job = getState(projectId).job
  if (!job) return
  startHighlightJob(projectId, {
    recordId: job.recordId,
    path: job.path,
    ranges: job.ranges,
    oldText: job.oldText,
    mode: 'stable',
  })
}

/** 关闭当前任务（同时消费对应通知） */
export function dismissHighlightJob(projectId: string): void {
  const state = getState(projectId)
  clearTimers(projectId)
  if (state.job) {
    dismissChangeNotice(projectId, state.job.recordId)
  }
  state.job = null
}

/** 入队一条变更通知（按记录 id 去重；超限丢最老的） */
export function pushChangeNotice(projectId: string, notice: ChangeNotice): void {
  const state = getState(projectId)
  if (state.notices.some((item) => item.recordId === notice.recordId)) return
  state.notices.push(notice)
  if (state.notices.length > MAX_CHANGE_NOTICES) {
    state.notices.splice(0, state.notices.length - MAX_CHANGE_NOTICES)
  }
}

/** 移除一条通知（已查看或用户手动关闭） */
export function dismissChangeNotice(projectId: string, recordId: string): void {
  const state = getState(projectId)
  const index = state.notices.findIndex((item) => item.recordId === recordId)
  if (index >= 0) {
    state.notices.splice(index, 1)
  }
}

/** 清空某项目的全部高亮状态（切项目时调用，跨项目不串扰） */
export function clearChangeHighlights(projectId: string): void {
  clearTimers(projectId)
  const state = getState(projectId)
  state.notices.splice(0)
  state.job = null
}

/** 组件侧入口：拿本项目状态的只读引用 + 动作集合 */
export function useChangeHighlights(projectId: string) {
  const state = getState(projectId)
  return {
    /** 响应式状态：notices（通知队列）与 job（当前高亮任务） */
    state,
    startJob: (params: StartJobParams) => startHighlightJob(projectId, params),
    advanceCursor: (delta: number) => advanceHighlightCursor(projectId, delta),
    replayJob: () => replayHighlightJob(projectId),
    dismissJob: () => dismissHighlightJob(projectId),
    dismissNotice: (recordId: string) => dismissChangeNotice(projectId, recordId),
  }
}

/** 测试注入口：拿模块内响应式状态（先 clear 再断言） */
export function _getHighlightState(projectId: string): ProjectHighlightState {
  return getState(projectId)
}

/** ===== 纯函数：高亮呈现的文本切分与 Markdown 块映射（单测覆盖） ===== */

/** 预览文本按高亮切出的渲染段；plain 段拼接（去掉 red 段）必须还原原内容 */
export type TextHighlightSegment = {
  kind: 'plain' | 'green' | 'red'
  text: string
}

/**
 * 待确认写入的预览切分（§8）：在当前磁盘内容里定位候选原文的全部出现处（replaceAll
 * 与 EditFile 落盘语义一致），原文以红段呈现、替换后的候选文本以绿段呈现，两段都只是
 * 预览、尚未写盘。返回 null 表示候选原文在当前内容中已找不到（版本失配，调用方降级）。
 * 非红段顺序拼接与原内容完全一致（排版不变的硬约束）。
 */
export function buildPendingReplaceSegments(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): TextHighlightSegment[] | null {
  // 空原文 = 空文件填充语义（EditFile 只对空文件放行）：整段候选内容绿显
  if (oldText === '') {
    if (content !== '') return [{ kind: 'plain', text: content }]
    return newText === '' ? [] : [{ kind: 'green', text: newText }]
  }
  if (!content.includes(oldText)) {
    return null
  }
  const segments: TextHighlightSegment[] = []
  let from = 0
  while (true) {
    const index = content.indexOf(oldText, from)
    if (index === -1) break
    if (index > from) {
      segments.push({ kind: 'plain', text: content.slice(from, index) })
    }
    segments.push({ kind: 'red', text: oldText })
    if (newText !== '') {
      segments.push({ kind: 'green', text: newText })
    }
    from = index + oldText.length
    if (!replaceAll) break
  }
  if (from < content.length) {
    segments.push({ kind: 'plain', text: content.slice(from) })
  }
  return segments
}

/**
 * 把当前游标处的一处修改切进整篇文本：新内容行绿显，被替换/删除的原文以相邻
 * 红段呈现（仅用于比较，不存在于当前内容中）。段落文本按整行边界拼接，
 * 所有非红段顺序拼接必须与原内容完全一致（排版不变的硬约束）。
 *
 * 行号口径与坐标一致：1-based 闭区间；空范围 end = start - 1。
 */
export function buildTextHighlightSegments(
  content: string,
  range: FileChangeRange,
  oldText: string,
): TextHighlightSegment[] {
  const lines = content.split('\n')
  const total = lines.length
  // 第 a..b 行（1-based 闭区间）的精确文本：行间补换行；非末行以换行结尾
  const sliceLines = (a: number, b: number): string => {
    if (b < a) return ''
    return lines.slice(a - 1, b).join('\n') + (b < total ? '\n' : '')
  }

  const segments: TextHighlightSegment[] = []
  const head = sliceLines(1, range.newStart - 1)
  if (head) segments.push({ kind: 'plain', text: head })

  // 红段：被替换/删除的原文（比较用）。原文若带尾换行去掉，段尾统一补一个换行
  if (range.oldEnd >= range.oldStart && oldText !== '') {
    const body = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText
    segments.push({ kind: 'red', text: `${body}\n` })
  }

  if (range.newEnd >= range.newStart) {
    const green = sliceLines(range.newStart, range.newEnd)
    if (green) segments.push({ kind: 'green', text: green })
  }

  const resume = Math.max(range.newEnd, range.newStart - 1) + 1
  const tail = sliceLines(resume, total)
  if (tail) segments.push({ kind: 'plain', text: tail })
  return segments
}

/**
 * Markdown 源码行 → 渲染块下标的同版本映射（§7「同版本源码到渲染块的映射，
 * 无法精确到块内时只定位完整块」）。blockStartLines 是各渲染块的源码起始行
 * （0-based，parseMarkdownBlocks 的 key 顺序即渲染顺序）；返回与该处修改
 * 相交的块下标（删除时 newEnd < newStart，取插入点所在块用于滚动定位）。
 */
export function markdownBlockIndicesInRange(
  blockStartLines: number[],
  totalLines: number,
  range: FileChangeRange,
): number[] {
  const from = range.newStart - 1
  const to = Math.max(range.newEnd, range.newStart - 1)
  const indices: number[] = []
  for (let i = 0; i < blockStartLines.length; i += 1) {
    const start = blockStartLines[i]
    const end = (i + 1 < blockStartLines.length ? blockStartLines[i + 1] : totalLines) - 1
    if (start <= to && end >= from) {
      indices.push(i)
    }
  }
  return indices
}
