import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

import type { DetailSavePhase } from '../components/layout/detail-save-phase'

type DetailMode = 'preview' | 'edit'

/**
 * 临时编辑（2026-11-23 交互增补）：预览态双击正文进入的编辑态标记为「临时」，
 * 双击即进入一个「快改窗口」——状态灯立即亮「等待保存」（displaySavePhase 覆写），
 * 静置 idleTimeoutMs（与自动保存去抖同窗，默认 2 秒）后自动收口回预览：
 * - 无改动（相位仍 clean）：直接回预览，不触发落盘；
 * - 有改动：相位离开 clean 即解除闲置计时，由自动保存链接管
 *   （pending → saving → clean 相位转变时自动回预览，与改动收口同一心智）。
 * 点「编辑」按钮进入的常规编辑不受影响（保存成功停在编辑态，支持连续调整）。
 *
 * 岔路一律升级为常规编辑（清标记）：保存冲突、保存失败（用户需要决策），
 * 以及手动切回预览（标记复位，再次双击重新标记）。
 */
export function useTransientEdit(options: {
  savePhase: MaybeRefOrGetter<DetailSavePhase>
  detailMode: MaybeRefOrGetter<DetailMode>
  onReturnToPreview: () => void
  /** 快改窗口时长（毫秒）：与自动保存去抖同窗，静置到期无改动直接回预览 */
  idleTimeoutMs?: number
}) {
  const idleTimeoutMs = options.idleTimeoutMs ?? 2000
  const transient = ref(false)
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  // 临时窗口计时只在「临时 + 编辑态 + 相位 clean」时武装：静置到期无改动直接回预览。
  // 相位一旦离开 clean（用户已输入，走自动保存链）即解除，不与保存链抢跑
  watch(
    () =>
      transient.value &&
      toValue(options.detailMode) === 'edit' &&
      toValue(options.savePhase) === 'clean',
    (shouldArm) => {
      if (shouldArm && idleTimer === null) {
        idleTimer = setTimeout(() => {
          idleTimer = null
          if (transient.value && toValue(options.savePhase) === 'clean') {
            transient.value = false
            options.onReturnToPreview()
          }
        }, idleTimeoutMs)
      } else if (!shouldArm) {
        clearIdleTimer()
      }
    },
  )

  watch(
    () => toValue(options.detailMode),
    (mode) => {
      if (mode === 'preview') transient.value = false
    },
  )

  watch(
    () => toValue(options.savePhase),
    (phase, prev) => {
      if (phase === 'conflict' || phase === 'failed') {
        transient.value = false
        return
      }
      // 只有「保存完成」的相位转变（pending/saving → clean）才弹回；
      // 静置无改动的收口由闲置计时负责，两者不重叠
      if (phase === 'clean' && prev !== 'clean' && transient.value) {
        transient.value = false
        options.onReturnToPreview()
      }
    },
  )

  // failSilently：纯函数式调用（无组件作用域）不告警
  onScopeDispose(clearIdleTimer, true)

  /** 展示层保存阶段：临时窗口内相位仍 clean 时显示「等待保存」（窗口计时的心智） */
  const displaySavePhase = computed<DetailSavePhase>(() => {
    const phase = toValue(options.savePhase)
    if (
      transient.value &&
      phase === 'clean' &&
      toValue(options.detailMode) === 'edit'
    ) {
      return 'pending'
    }
    return phase
  })

  return {
    /** 双击进入编辑前调用，把本次编辑标记为临时（快改即走） */
    markTransient: () => {
      transient.value = true
    },
    /** 是否处于临时编辑（供展示层做窗口态判断） */
    transient,
    /** 展示层保存阶段：临时窗口内 clean 显示为「等待保存」，其余同真实相位 */
    displaySavePhase,
  }
}
