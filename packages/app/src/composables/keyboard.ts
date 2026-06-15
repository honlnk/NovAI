type KeyboardLikeEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'keyCode'>

export function isImeComposing(event: KeyboardLikeEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

export function shouldSubmitOnEnter(event: KeyboardLikeEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)
}
