import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import { useDelayedFlag } from './use-delayed-flag'

/**
 * 延迟置真的标志（《项目打开进度与移动端授权修复计划》§4）：
 * 快速完成的动作不闪现等待提示——源标志持续为真满 300 毫秒才置真。
 */
describe('useDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(delayMs?: number) {
    const source = ref(false)
    const scope = effectScope()
    const delayed = scope.run(() => useDelayedFlag(source, delayMs))

    if (!delayed) {
      throw new Error('useDelayedFlag 未返回标志')
    }
    return { source, scope, delayed }
  }

  it('源标志持续为真满 300 毫秒才置真', async () => {
    const { source, delayed } = setup()

    source.value = true
    await nextTick()
    expect(delayed.value).toBe(false)

    vi.advanceTimersByTime(299)
    expect(delayed.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(delayed.value).toBe(true)
  })

  it('源提前回落：不置位', async () => {
    const { source, delayed } = setup()

    source.value = true
    await nextTick()
    vi.advanceTimersByTime(100)
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(1000)

    expect(delayed.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('源回落时立刻复位，再次置真重新计时', async () => {
    const { source, delayed } = setup()

    source.value = true
    await nextTick()
    vi.advanceTimersByTime(300)
    expect(delayed.value).toBe(true)

    source.value = false
    await nextTick()
    expect(delayed.value).toBe(false)

    source.value = true
    await nextTick()
    vi.advanceTimersByTime(299)
    expect(delayed.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(delayed.value).toBe(true)
  })

  it('作用域销毁时清理计时器', async () => {
    const { source, scope, delayed } = setup()

    source.value = true
    await nextTick()
    scope.stop()
    vi.advanceTimersByTime(1000)

    expect(delayed.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('可指定延迟时长', async () => {
    const { source, delayed } = setup(1000)

    source.value = true
    await nextTick()
    vi.advanceTimersByTime(999)
    expect(delayed.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(delayed.value).toBe(true)
  })
})
