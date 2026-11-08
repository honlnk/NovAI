import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

/** 轻提示内联动作按钮（如归档撤销、查看已归档）；点击后提示即关闭 */
export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastOptions {
  /** 展示时长（毫秒），缺省 3000；带撤销动作的提示建议 5000。error 缺省持续显示（见 ToastMessage.persistent） */
  duration?: number
  /** 内联动作按钮（可多个，如归档的「撤销」「查看已归档」）；多条提示并存时各自动作互不影响 */
  actions?: ToastAction[]
}

export interface ToastMessage {
  id: number
  message: string
  type: ToastType
  /** 自动关闭时长（毫秒）；渲染层缺省 3000。显式传 duration 时记录在此供渲染层使用 */
  duration?: number
  /**
   * 持续显示（数据安全计划 F11）：不自动关闭，出口是用户手动关闭或进入对应现场。
   * error 未显式指定 duration 时默认持续——错误原因不能在用户读完之前消失；
   * success / info / warning 保持既定时长不回归。
   */
  persistent?: boolean
  actions?: ToastAction[]
}

const toasts = ref<ToastMessage[]>([])
let nextId = 0

export function useToast() {
  function show(message: string, type: ToastType = 'info', options?: ToastOptions) {
    const id = nextId++
    toasts.value.push({
      id,
      message,
      type,
      ...(options?.duration !== undefined ? { duration: options.duration } : {}),
      ...(type === 'error' && options?.duration === undefined ? { persistent: true } : {}),
      ...(options?.actions?.length ? { actions: options.actions } : {}),
    })
  }

  function success(message: string, options?: ToastOptions) {
    show(message, 'success', options)
  }

  function error(message: string, options?: ToastOptions) {
    show(message, 'error', options)
  }

  function info(message: string, options?: ToastOptions) {
    show(message, 'info', options)
  }

  /** 黄色提醒级：非破坏性中断、需要用户补充操作的中性提示，不是错误 */
  function warning(message: string, options?: ToastOptions) {
    show(message, 'warning', options)
  }

  function remove(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return {
    toasts,
    show,
    success,
    error,
    info,
    warning,
    remove,
  }
}
