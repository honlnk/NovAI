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
 * IME 组字期（含 Safari compositionend 后尾窗）按键放行时，是否需要吞掉浏览器默认行为。
 *
 * contenteditable 的 Enter 默认会插入新段落：组字期/尾窗放行后若不拦截，
 * Lexical 会在编辑器里留下一个游离空段（「发送残行」的根因）。因此 Enter
 * （非 Shift+Enter）在放行分支里也要 preventDefault；Shift+Enter 的换行
 * 默认行为保留，输入法导航键不动。
 */
export function shouldBlockImeDefault(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'Enter' && !event.shiftKey
}
