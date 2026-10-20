type KeyboardLikeEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode'
>

/** IME 判定只需要组合态两个字段（更窄的形参让部分事件的调用方也能复用） */
type CompositionLikeEvent = Pick<KeyboardEvent, 'isComposing' | 'keyCode'>

export function isImeComposing(event: CompositionLikeEvent): boolean {
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

/**
 * 一键管理要素快捷键（要素管理员 Phase 2 W2 快捷入口）：Ctrl/Cmd+Shift+G。
 * 窗口级监听（不限输入框焦点）；带修饰键的组合不会处于输入法组合中，无需 IME 排除。
 * Shift 按下时 key 为大写 'G'，比较前统一 toLowerCase。
 */
export function isElementManagerShortcut(event: KeyboardLikeEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'g'
}
