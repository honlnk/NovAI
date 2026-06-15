import { describe, expect, it } from 'vitest'
import { isImeComposing, shouldSubmitOnEnter } from './keyboard'

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  } as KeyboardEvent
}

describe('keyboard helpers', () => {
  it('detects IME composition events', () => {
    expect(isImeComposing(keyEvent({ isComposing: true }))).toBe(true)
    expect(isImeComposing(keyEvent({ keyCode: 229 }))).toBe(true)
    expect(isImeComposing(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false)
  })

  it('submits only for a plain Enter outside IME composition', () => {
    expect(shouldSubmitOnEnter(keyEvent({ key: 'Enter' }))).toBe(true)
    expect(shouldSubmitOnEnter(keyEvent({ key: 'Enter', shiftKey: true }))).toBe(false)
    expect(shouldSubmitOnEnter(keyEvent({ key: 'Enter', isComposing: true }))).toBe(false)
    expect(shouldSubmitOnEnter(keyEvent({ key: 'Enter', keyCode: 229 }))).toBe(false)
  })
})
