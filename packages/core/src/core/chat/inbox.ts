import type { InboxState, QueuedMessage } from '../../types/chat'

/**
 * 双队列收件箱纯函数集（照抄 dsh 语义，不可变更新）：
 *
 * - nextTurn（followup 排队）：每次 turn 恰取 1 条，FIFO；
 * - nextStep（steer 插话）：下一个 step 边界整队抽干；
 * - turn 首批 = 先全部 next-step、后 1 条 next-turn；
 * - claim 即消费，抽干不回滚。
 *
 * 所有函数不改动入参，返回新 state；`undefined` 收件箱视为空队列（旧会话兼容）。
 */

export type InboxTarget = 'next-turn' | 'next-step'

export function createEmptyInbox(): InboxState {
  return { nextTurn: [], nextStep: [] }
}

export function inboxOrEmpty(state: InboxState | undefined): InboxState {
  return state ?? createEmptyInbox()
}

/** 入队：返回新 state 与带 id/at 的消息本体。activeFilePath 随消息快照（undefined 不落字段）。 */
export function enqueueToInbox(
  state: InboxState | undefined,
  target: InboxTarget,
  input: { text: string; quote?: string; activeFilePath?: string | null },
): { state: InboxState; message: QueuedMessage } {
  const current = inboxOrEmpty(state)
  const message: QueuedMessage = {
    id: createQueuedMessageId(),
    text: input.text,
    ...(input.quote ? { quote: input.quote } : {}),
    ...(input.activeFilePath !== undefined ? { activeFilePath: input.activeFilePath } : {}),
    at: new Date().toISOString(),
  }

  return {
    state: {
      nextTurn: target === 'next-turn' ? [...current.nextTurn, message] : current.nextTurn,
      nextStep: target === 'next-step' ? [...current.nextStep, message] : current.nextStep,
    },
    message,
  }
}

/**
 * 抽干：next-step 整队取走；next-turn 恰取 1 条（FIFO 头）。
 * claim 即消费——返回的 state 已移除被取消息，不回滚。
 */
export function claimFromInbox(
  state: InboxState | undefined,
  target: InboxTarget,
): { state: InboxState; messages: QueuedMessage[] } {
  const current = inboxOrEmpty(state)

  if (target === 'next-step') {
    return { state: { ...current, nextStep: [] }, messages: current.nextStep }
  }

  return {
    state: { ...current, nextTurn: current.nextTurn.slice(1) },
    messages: current.nextTurn.slice(0, 1),
  }
}

/**
 * turn 首批（dsh claim('next-turn') 同款）：next-step 全量 + next-turn 恰 1 条。
 * 批次内顺序：先全部 steer，后 followup。
 */
export function claimTurnStartBatch(state: InboxState | undefined): {
  state: InboxState
  steering: QueuedMessage[]
  followup?: QueuedMessage
} {
  const steeringClaim = claimFromInbox(state, 'next-step')
  const followupClaim = claimFromInbox(steeringClaim.state, 'next-turn')

  return {
    state: followupClaim.state,
    steering: steeringClaim.messages,
    followup: followupClaim.messages[0],
  }
}

/** 删除指定排队消息（QueueDock 撤回）；不存在则原样返回。 */
export function removeFromInbox(state: InboxState | undefined, id: string): InboxState {
  const current = inboxOrEmpty(state)
  return {
    nextTurn: current.nextTurn.filter((message) => message.id !== id),
    nextStep: current.nextStep.filter((message) => message.id !== id),
  }
}

/** 就地改文案（QueueDock 行内编辑）；不存在则原样返回。 */
export function replaceInInbox(state: InboxState | undefined, id: string, text: string): InboxState {
  const current = inboxOrEmpty(state)
  const apply = (message: QueuedMessage) => (message.id === id ? { ...message, text } : message)
  return {
    nextTurn: current.nextTurn.map(apply),
    nextStep: current.nextStep.map(apply),
  }
}

/** 把排队消息从 next-turn 升级为 next-step（QueueDock「立即插话」）；不存在则原样返回。 */
export function moveToNextStep(state: InboxState | undefined, id: string): InboxState {
  const current = inboxOrEmpty(state)
  const message = current.nextTurn.find((item) => item.id === id)
  if (!message) {
    return current
  }
  return {
    nextTurn: current.nextTurn.filter((item) => item.id !== id),
    nextStep: [...current.nextStep, message],
  }
}

/** 清空两个队列。 */
export function clearInbox(state: InboxState | undefined): InboxState {
  void state
  return createEmptyInbox()
}

/** 任一队列有待处理消息。 */
export function hasPendingMessages(state: InboxState | undefined): boolean {
  const current = inboxOrEmpty(state)
  return current.nextTurn.length > 0 || current.nextStep.length > 0
}

function createQueuedMessageId() {
  return `queued-${Math.random().toString(36).slice(2, 10)}`
}
