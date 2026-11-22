// @vitest-environment happy-dom
/**
 * 临时编辑组合式（2026-11-23 交互增补）：预览态双击正文进入的编辑态标记为
 * 「临时」，自动保存成功（pending/saving → clean）即回预览——快改即走。
 * 点「编辑」按钮进入的常规编辑不受影响；冲突/失败/手动切回预览升级为常规。
 * 静置无改动：双击即亮「等待保存」（displaySavePhase 覆写），同窗静置到期直接回预览。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { useTransientEdit } from './useTransientEdit'

const IDLE_MS = 200

function makeRefs() {
  return {
    savePhase: ref<'clean' | 'pending' | 'saving' | 'failed' | 'conflict'>('clean'),
    detailMode: ref<'preview' | 'edit'>('preview'),
    onReturn: vi.fn(),
  }
}

describe('useTransientEdit 临时编辑', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('标记后保存相位 pending → clean：回调回预览一次，标记复位', async () => {
    const { savePhase, detailMode, onReturn } = makeRefs()
    const { markTransient } = useTransientEdit({ savePhase, detailMode, onReturnToPreview: onReturn })

    // 双击进入临时编辑
    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()

    // 输入 → 去抖等待 → 在途 → 成功：clean 相位转变时弹回
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'saving'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).toHaveBeenCalledTimes(1)
    // 复位后再遇 clean（无相位转变）不重复弹回
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('静置无改动：立即显示「等待保存」，同窗到期直接回预览', async () => {
    const { savePhase, detailMode, onReturn } = makeRefs()
    const { markTransient, displaySavePhase } = useTransientEdit({
      savePhase,
      detailMode,
      onReturnToPreview: onReturn,
      idleTimeoutMs: IDLE_MS,
    })

    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    // 相位仍 clean（无改动）：展示层覆写为「等待保存」
    expect(displaySavePhase.value).toBe('pending')
    expect(savePhase.value).toBe('clean')

    // 静置到期：直接回预览，不经过保存链
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10)
    expect(onReturn).toHaveBeenCalledTimes(1)
    await nextTick()
    expect(displaySavePhase.value).toBe('clean')
  })

  it('输入使相位离开 clean：闲置计时解除，改由保存链收口', async () => {
    const { savePhase, detailMode, onReturn } = makeRefs()
    const { markTransient, displaySavePhase } = useTransientEdit({
      savePhase,
      detailMode,
      onReturnToPreview: onReturn,
      idleTimeoutMs: IDLE_MS,
    })

    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    expect(displaySavePhase.value).toBe('pending')

    // 用户开始输入：相位 pending，计时解除——静置到期不弹（保存链负责）
    savePhase.value = 'pending'
    await nextTick()
    expect(displaySavePhase.value).toBe('pending')
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100)
    expect(onReturn).not.toHaveBeenCalled()

    // 保存完成（pending → saving → clean）：既有弹回路径生效
    savePhase.value = 'saving'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('常规编辑（未标记）：保存成功不弹回', async () => {
    const { savePhase, detailMode, onReturn } = makeRefs()
    const { markTransient, displaySavePhase } = useTransientEdit({
      savePhase,
      detailMode,
      onReturnToPreview: onReturn,
    })

    detailMode.value = 'edit'
    await nextTick()
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()
    // 常规编辑 clean 恒 clean：不覆写展示
    expect(displaySavePhase.value).toBe('clean')
    expect(markTransient).toBeDefined()
  })

  it('冲突与失败升级为常规编辑：标记清除，后续保存成功不弹回', async () => {
    const savePhase = ref<'clean' | 'pending' | 'saving' | 'failed' | 'conflict'>('clean')
    const detailMode = ref<'preview' | 'edit'>('preview')
    const onReturn = vi.fn()
    const { markTransient } = useTransientEdit({ savePhase, detailMode, onReturnToPreview: onReturn })

    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'conflict'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()

    // 失败同理：重新标记 → 失败 → 成功不弹回
    markTransient()
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'failed'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()
  })

  it('手动切回预览复位标记：再次进入编辑后保存成功仍会弹回', async () => {
    const savePhase = ref<'clean' | 'pending' | 'saving' | 'failed' | 'conflict'>('clean')
    const detailMode = ref<'preview' | 'edit'>('preview')
    const onReturn = vi.fn()
    const { markTransient } = useTransientEdit({ savePhase, detailMode, onReturnToPreview: onReturn })

    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    // 用户手动点「预览」切回 → 标记复位
    detailMode.value = 'preview'
    await nextTick()
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()

    // 再次双击临时编辑：完整链路仍生效
    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    savePhase.value = 'pending'
    await nextTick()
    savePhase.value = 'clean'
    await nextTick()
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('进入编辑态时相位恒 clean（未改动）：无双变不误弹', async () => {
    const savePhase = ref<'clean' | 'pending' | 'saving' | 'failed' | 'conflict'>('clean')
    const detailMode = ref<'preview' | 'edit'>('preview')
    const onReturn = vi.fn()
    const { markTransient } = useTransientEdit({ savePhase, detailMode, onReturnToPreview: onReturn })

    markTransient()
    detailMode.value = 'edit'
    await nextTick()
    await nextTick()
    expect(onReturn).not.toHaveBeenCalled()
  })
})
