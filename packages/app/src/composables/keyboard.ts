type KeyboardLikeEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode'
>

export function isImeComposing(event: KeyboardLikeEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

export function shouldSubmitOnEnter(event: KeyboardLikeEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)
}

/**
 * 发送模式解析（照 dsh resolveSubmitMode）：
 * - Enter → submit（空闲=直接发送；运行中=排队进 QueueDock）
 * - Ctrl/Cmd+Enter → steer（插话，下一 step 边界生效）
 * - Shift+Enter / 输入法组合中 / 其他键 → null（不发送）
 */
export type SubmitMode = 'submit' | 'steer'

export function resolveSubmitMode(event: KeyboardLikeEvent): SubmitMode | null {
  if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) {
    return null
  }
  return event.ctrlKey || event.metaKey ? 'steer' : 'submit'
}
