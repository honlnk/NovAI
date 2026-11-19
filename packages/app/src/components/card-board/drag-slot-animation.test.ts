import { describe, expect, it, vi } from 'vitest'

import { animateDragSlot, interpolateDragSlotFrame } from './drag-slot-animation'

const full = { height: 88, paddingBottom: 8, opacity: 1 }
const zero = { height: 0, paddingBottom: 0, opacity: 0 }

describe('拖拽卡片槽逐帧动画', () => {
  it('时间中点高度/间距/透明度均为一半，结束后稳定到终态', () => {
    let now = 0
    let scheduled: (() => void) | undefined
    const onFrame = vi.fn()
    const onComplete = vi.fn()
    animateDragSlot(zero, full, 180, onFrame, onComplete, {
      now: () => now,
      setTimer: (callback) => {
        scheduled = callback
        return 1
      },
      clearTimer: () => {},
    })

    now = 90
    scheduled?.()
    expect(onFrame).toHaveBeenLastCalledWith({ height: 44, paddingBottom: 4, opacity: 0.5 })
    expect(onComplete).not.toHaveBeenCalled()

    now = 240
    scheduled?.()
    expect(onFrame).toHaveBeenLastCalledWith(full)
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('取消后已排队的帧不再回写', () => {
    const callback = vi.fn()
    const clearTimer = vi.fn()
    const cancel = animateDragSlot(full, zero, 160, callback, () => {}, {
      setTimer: () => 42,
      clearTimer,
    })
    cancel()
    expect(clearTimer).toHaveBeenCalledWith(42)
    expect(callback).not.toHaveBeenCalled()
  })

  it('减少动态效果时直接终态', () => {
    const onFrame = vi.fn()
    const onComplete = vi.fn()
    animateDragSlot(zero, full, 180, onFrame, onComplete, { reducedMotion: true })
    expect(onFrame).toHaveBeenCalledWith(full)
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('插值将进度夹在 0~1，不出现过冲', () => {
    expect(interpolateDragSlotFrame(zero, full, -1)).toEqual(zero)
    expect(interpolateDragSlotFrame(zero, full, 2)).toEqual(full)
  })
})
