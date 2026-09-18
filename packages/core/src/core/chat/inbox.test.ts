import { describe, expect, it } from 'vitest'

import {
  claimFromInbox,
  claimTurnStartBatch,
  clearInbox,
  createEmptyInbox,
  enqueueToInbox,
  hasPendingMessages,
  inboxOrEmpty,
  moveToNextStep,
  removeFromInbox,
  replaceInInbox,
} from './inbox'

function enqueueN(state: ReturnType<typeof createEmptyInbox>, target: 'next-turn' | 'next-step', texts: string[]) {
  let current = state
  const ids: string[] = []
  for (const text of texts) {
    const result = enqueueToInbox(current, target, { text })
    current = result.state
    ids.push(result.message.id)
  }
  return { state: current, ids }
}

describe('inbox 纯函数集', () => {
  it('undefined 收件箱视为空队列（旧会话兼容）', () => {
    expect(inboxOrEmpty(undefined)).toEqual({ nextTurn: [], nextStep: [] })
    expect(hasPendingMessages(undefined)).toBe(false)
    expect(claimFromInbox(undefined, 'next-step').messages).toEqual([])
    expect(claimTurnStartBatch(undefined).followup).toBeUndefined()
  })

  it('enqueue 不可变：原 state 不被改动，消息带 id/at', () => {
    const empty = createEmptyInbox()
    const { state, message } = enqueueToInbox(empty, 'next-turn', { text: '第一条', quote: '引用' })

    expect(empty.nextTurn).toHaveLength(0)
    expect(state.nextTurn).toHaveLength(1)
    expect(message).toMatchObject({ text: '第一条', quote: '引用' })
    expect(message.id).toBeTruthy()
    expect(message.at).toBeTruthy()
  })

  it('claim next-step 整队抽干；claim next-turn 恰取 1 条（FIFO）', () => {
    const empty = createEmptyInbox()
    const steer = enqueueN(empty, 'next-step', ['插话一', '插话二', '插话三'])
    const both = enqueueN(steer.state, 'next-turn', ['排队一', '排队二'])

    const stepClaim = claimFromInbox(both.state, 'next-step')
    expect(stepClaim.messages.map((m) => m.text)).toEqual(['插话一', '插话二', '插话三'])
    expect(stepClaim.state.nextStep).toHaveLength(0)
    // 抽干 next-step 不动 next-turn
    expect(stepClaim.state.nextTurn).toHaveLength(2)

    const turnClaim = claimFromInbox(both.state, 'next-turn')
    expect(turnClaim.messages.map((m) => m.text)).toEqual(['排队一'])
    expect(turnClaim.state.nextTurn.map((m) => m.text)).toEqual(['排队二'])
    // 抽干不回滚：再次 claim 只剩后续
    const again = claimFromInbox(turnClaim.state, 'next-turn')
    expect(again.messages.map((m) => m.text)).toEqual(['排队二'])
    expect(again.state.nextTurn).toHaveLength(0)
  })

  it('turn 首批 = 先全部 next-step、后 1 条 next-turn', () => {
    const empty = createEmptyInbox()
    const followups = enqueueN(empty, 'next-turn', ['任务一', '任务二'])
    const both = enqueueN(followups.state, 'next-step', ['插话甲', '插话乙'])

    const batch = claimTurnStartBatch(both.state)
    expect(batch.steering.map((m) => m.text)).toEqual(['插话甲', '插话乙'])
    expect(batch.followup?.text).toBe('任务一')
    expect(batch.state.nextTurn.map((m) => m.text)).toEqual(['任务二'])
    expect(batch.state.nextStep).toHaveLength(0)
  })

  it('remove / replace / moveToNextStep / clear / hasPending', () => {
    const empty = createEmptyInbox()
    const { state: s1, ids } = enqueueN(empty, 'next-turn', ['一', '二', '三'])

    // replace 就地改文案
    const s2 = replaceInInbox(s1, ids[1], '二（改）')
    expect(s2.nextTurn.map((m) => m.text)).toEqual(['一', '二（改）', '三'])
    expect(s1.nextTurn[1].text).toBe('二') // 不可变

    // moveToNextStep 升级为插话
    const s3 = moveToNextStep(s2, ids[0])
    expect(s3.nextTurn.map((m) => m.text)).toEqual(['二（改）', '三'])
    expect(s3.nextStep.map((m) => m.text)).toEqual(['一'])

    // remove 删除
    const s4 = removeFromInbox(s3, ids[2])
    expect(s4.nextTurn.map((m) => m.text)).toEqual(['二（改）'])
    expect(hasPendingMessages(s4)).toBe(true)

    // 不存在的 id 原样返回
    expect(removeFromInbox(s4, 'missing')).toEqual(s4)
    expect(replaceInInbox(s4, 'missing', 'x')).toEqual(s4)
    expect(moveToNextStep(s4, 'missing')).toEqual(s4)

    // clear 清空
    const s5 = clearInbox(s4)
    expect(hasPendingMessages(s5)).toBe(false)
  })
})
