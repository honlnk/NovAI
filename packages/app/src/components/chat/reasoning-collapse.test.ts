import { describe, expect, it } from 'vitest'

import { createReasoningCollapseState } from './reasoning-collapse'

describe('ReasoningCollapse 折叠状态机', () => {
  it('流式：思考中自动展开，正文开始（thinking 翻 false）自动收起', () => {
    const state = createReasoningCollapseState()
    expect(state.expanded(true)).toBe(true)
    expect(state.expanded(false)).toBe(false)
  })

  it('历史消息：默认收起，点击展开，再点收起', () => {
    const state = createReasoningCollapseState()
    expect(state.expanded(false)).toBe(false)
    state.toggle(false)
    expect(state.expanded(false)).toBe(true)
    state.toggle(true)
    expect(state.expanded(false)).toBe(false)
  })

  it('思考中手动收起后，正文开始保持手动值（不弹回自动展开）', () => {
    const state = createReasoningCollapseState()
    state.toggle(true)
    expect(state.expanded(true)).toBe(false)
    expect(state.expanded(false)).toBe(false)
  })

  it('各消息实例状态独立（新消息不受旧消息手动值影响）', () => {
    const first = createReasoningCollapseState()
    first.toggle(false)
    const second = createReasoningCollapseState()
    expect(second.expanded(false)).toBe(false)
    expect(second.expanded(true)).toBe(true)
  })
})
