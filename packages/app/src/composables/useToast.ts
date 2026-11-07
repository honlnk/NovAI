import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastMessage {
  id: number
  message: string
  type: ToastType
}

const toasts = ref<ToastMessage[]>([])
let nextId = 0

export function useToast() {
  function show(message: string, type: ToastType = 'info') {
    const id = nextId++
    toasts.value.push({ id, message, type })
  }

  function success(message: string) {
    show(message, 'success')
  }

  function error(message: string) {
    show(message, 'error')
  }

  function info(message: string) {
    show(message, 'info')
  }

  /** 黄色提醒级：非破坏性中断、需要用户补充操作的中性提示，不是错误 */
  function warning(message: string) {
    show(message, 'warning')
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
