import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * 延迟置真的标志：源标志持续为真满 delayMs 毫秒才置真，源提前回落则不置位。
 * 用于「快速完成不闪现」的等待提示——桌面端几百毫秒就完成的动作不打扰用户。
 */
export function useDelayedFlag(source: Readonly<Ref<boolean>>, delayMs = 300) {
  const delayed = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  watch(
    source,
    (value) => {
      clearTimeout(timer)
      if (!value) {
        delayed.value = false
        return
      }
      timer = setTimeout(() => {
        delayed.value = true
      }, delayMs)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    clearTimeout(timer)
  })

  return delayed
}
