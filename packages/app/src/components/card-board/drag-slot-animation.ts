/**
 * 原生拖拽中的卡片槽动画。不能用 rAF（拖拽期间可能暂停）；CSS transition 在部分
 * WebView 的合成拖拽中也不会推进，因此由 setTimeout 采样 monotonic 时钟逐帧插值。
 * 系统要求减少动态效果时直接到终态；每段动画有独立取消函数，落点切换互不影响。
 */
export type DragSlotFrame = {
  height: number
  paddingBottom: number
  opacity: number
}

export type DragAnimationClock = {
  now: () => number
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}

type FrameTimer = ReturnType<typeof setTimeout>
type CancelFrameTimer = (timer: FrameTimer) => void

export function interpolateDragSlotFrame(
  from: DragSlotFrame,
  to: DragSlotFrame,
  progress: number,
): DragSlotFrame {
  const t = Math.max(0, Math.min(1, progress))
  return {
    height: from.height + (to.height - from.height) * t,
    paddingBottom: from.paddingBottom + (to.paddingBottom - from.paddingBottom) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
  }
}

export function animateDragSlot(
  from: DragSlotFrame,
  to: DragSlotFrame,
  durationMs: number,
  onFrame: (frame: DragSlotFrame) => void,
  onComplete: () => void = () => {},
  options: Partial<DragAnimationClock> & { reducedMotion?: boolean } = {},
): () => void {
  if (options.reducedMotion || durationMs <= 0) {
    onFrame(to)
    onComplete()
    return () => {}
  }

  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? ((timer: FrameTimer) => clearTimeout(timer))
  // 时钟与计时器同源：测试替换 setTimeout 时不能让 performance.now 偷偷前进
  const now = options.now ?? (options.setTimer ? Date.now : () => performance.now())
  const startedAt = now()
  let timer: FrameTimer | null = null
  let cancelled = false

  const tick = () => {
    if (cancelled) {
      return
    }
    const progress = (now() - startedAt) / durationMs
    onFrame(interpolateDragSlotFrame(from, to, progress))
    if (progress >= 1) {
      timer = null
      onComplete()
      return
    }
    // 时间驱动而非固定步长：掉帧只会跳过中间帧，不改变总时长与终态
    timer = setTimer(tick, 16)
  }
  timer = setTimer(tick, 16)

  return () => {
    cancelled = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }
}
