import { describe, expect, it } from 'vitest'
import { isElementManagerShortcut, isImeComposing, resolveSubmitMode, shouldSubmitOnEnter } from './keyboard'

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

  it('isElementManagerShortcut：仅 Ctrl/Cmd+Shift+G 命中，大小写与缺修饰键均不误触（W2）', () => {
    // Shift 按下时浏览器报大写 'G'，两种形态都要命中
    expect(isElementManagerShortcut(keyEvent({ key: 'G', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isElementManagerShortcut(keyEvent({ key: 'g', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isElementManagerShortcut(keyEvent({ key: 'G', ctrlKey: true, shiftKey: true }))).toBe(true)
    // 缺 Shift / 缺主修饰键 / 其他键位 / 无修饰键，都不触发
    expect(isElementManagerShortcut(keyEvent({ key: 'g', metaKey: true }))).toBe(false)
    expect(isElementManagerShortcut(keyEvent({ key: 'G', shiftKey: true }))).toBe(false)
    expect(isElementManagerShortcut(keyEvent({ key: 'E', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isElementManagerShortcut(keyEvent({ key: 'g' }))).toBe(false)
    // Ctrl+Cmd 同按时仍算命中（macOS 上 Cmd 优先，无害）
    expect(isElementManagerShortcut(keyEvent({ key: 'G', ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(true)
  })
})
