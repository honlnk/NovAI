import { describe, expect, it } from 'vitest'
import { isImeComposing, resolveSubmitMode, shouldSubmitOnEnter } from './keyboard'

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
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

  it('resolveSubmitMode：Enter=submit、Ctrl/Cmd+Enter=steer、Shift+Enter/IME=不发送（文档 4 S5）', () => {
    expect(resolveSubmitMode(keyEvent({ key: 'Enter' }))).toBe('submit')
    expect(resolveSubmitMode(keyEvent({ key: 'Enter', ctrlKey: true }))).toBe('steer')
    expect(resolveSubmitMode(keyEvent({ key: 'Enter', metaKey: true }))).toBe('steer')
    expect(resolveSubmitMode(keyEvent({ key: 'Enter', shiftKey: true }))).toBeNull()
    expect(resolveSubmitMode(keyEvent({ key: 'Enter', isComposing: true }))).toBeNull()
    expect(resolveSubmitMode(keyEvent({ key: 'Enter', keyCode: 229 }))).toBeNull()
    expect(resolveSubmitMode(keyEvent({ key: 'a' }))).toBeNull()
    expect(resolveSubmitMode(keyEvent({ key: 'Tab' }))).toBeNull()
  })
})
