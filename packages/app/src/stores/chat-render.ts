import type { ChatMessageView } from '@novai/core/services/types'

/**
 * 聊天区渲染序列预处理（文档 3 S4）：把 messages 数组转成渲染树。
 * 两件事：① tool-call/tool-result 按 toolCallId 配成单行；② 一轮任务的过程消息
 * 折叠成一行摘要组。配对与分组都收在这一个纯函数里，组件只负责渲染。
 */

export type SystemMessageView = Extract<ChatMessageView, { role: 'system' }>
/** services 的 system 分支把四种 kind 合并成一个成员，Extract 拆不开，用交叉收窄 */
export type ToolCallMessageView = SystemMessageView & { kind: 'tool-call' }
export type ToolResultMessageView = SystemMessageView & { kind: 'tool-result' }
export type UserTextMessageView = Extract<ChatMessageView, { role: 'user' }>

/** 一次工具调用从头到尾占一行：调用时只有 call，结果回来原地配上 result。 */
export type ToolRowItem = {
  kind: 'tool-row'
  /** 配对成功取 call 的 id；孤立的 result（旧数据无 toolCallId）取自身 id */
  id: string
  call?: ToolCallMessageView
  result?: ToolResultMessageView
}

/**
 * 一轮任务的过程消息折叠组：从一条 user 消息到下一条 user 消息之间的
 * context-summary / 工具行 / 中间 assistant 文本，默认折叠成一行计数摘要。
 * 组 id = 组首 user 消息 id。
 */
export type ProcessGroupItem = {
  kind: 'process-group'
  id: string
  items: ChatRenderItem[]
  toolCallCount: number
  messageCount: number
  collapsed: boolean
}

export type ChatRenderItem =
  | { kind: 'message'; message: ChatMessageView }
  | ToolRowItem
  | ProcessGroupItem

function isTurnBoundary(item: ChatRenderItem): item is { kind: 'message'; message: UserTextMessageView } {
  return (
    item.kind === 'message'
    && item.message.role === 'user'
    && item.message.kind === 'text'
    // steering 插话不是组边界（组内常显成员）
    && item.message.steered !== true
  )
}

/** 组内最后一条 assistant text = 最终回答（永不折叠白名单）；中间 assistant 文本是过程消息。 */
function isFinalAnswer(item: ChatRenderItem, turnItems: ChatRenderItem[]): boolean {
  if (item.kind !== 'message' || item.message.role !== 'assistant' || item.message.kind !== 'text') {
    return false
  }
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const candidate = turnItems[index]
    if (candidate.kind === 'message' && candidate.message.role === 'assistant' && candidate.message.kind === 'text') {
      return candidate === item
    }
  }
  return false
}

/** 永不折叠白名单：user、最终回答、change-summary、error、旧版 action-summary；其余系统/中间消息进组。 */
function isProcessItem(item: ChatRenderItem, turnItems: ChatRenderItem[]): boolean {
  if (item.kind === 'tool-row') {
    return true
  }
  if (item.kind !== 'message') {
    return false
  }
  const message = item.message
  if (message.role === 'system') {
    return message.kind === 'context-summary'
  }
  if (message.role === 'assistant' && message.kind === 'text') {
    return !isFinalAnswer(item, turnItems)
  }
  return false
}

/**
 * @param running 当前会话是否在运行：运行中的最后一轮不折叠，run-finish 后默认自动收起
 * @param expandedOverrides 用户显式展开/收起记录（组 id → 是否展开），优先级高于默认
 */
export function buildRenderItems(
  messages: ChatMessageView[],
  options: { running: boolean; expandedOverrides?: ReadonlyMap<string, boolean> },
): ChatRenderItem[] {
  // ① 工具行配对：tool-result 按 toolCallId 挂到对应行；配不上（旧数据无字段）各自独立成行
  const paired: ChatRenderItem[] = []
  const rowByCallId = new Map<string, ToolRowItem>()
  for (const message of messages) {
    if (message.role === 'system' && message.kind === 'tool-call') {
      const row: ToolRowItem = { kind: 'tool-row', id: message.id, call: message }
      paired.push(row)
      if (message.toolCallId) {
        rowByCallId.set(message.toolCallId, row)
      }
      continue
    }
    if (message.role === 'system' && message.kind === 'tool-result') {
      const matched = message.toolCallId ? rowByCallId.get(message.toolCallId) : undefined
      if (matched && !matched.result) {
        matched.result = message
        continue
      }
      paired.push({ kind: 'tool-row', id: message.id, result: message })
      continue
    }
    paired.push({ kind: 'message', message })
  }

  // ② 按 user 边界切轮次；首条 user 之前的消息（旧会话残留）原样置顶不进组
  const leading: ChatRenderItem[] = []
  const turns: { id: string; items: ChatRenderItem[] }[] = []
  for (const item of paired) {
    if (isTurnBoundary(item)) {
      turns.push({ id: item.message.id, items: [item] })
    } else if (turns.length > 0) {
      turns[turns.length - 1].items.push(item)
    } else {
      leading.push(item)
    }
  }

  const output: ChatRenderItem[] = [...leading]
  turns.forEach((turn, turnIndex) => {
    const isLastTurn = turnIndex === turns.length - 1
    const processItems = turn.items.filter((item) => isProcessItem(item, turn.items))

    // 纯问答轮（无过程消息）不出折叠行
    if (processItems.length === 0) {
      output.push(...turn.items)
      return
    }

    const override = options.expandedOverrides?.get(turn.id)
    const expanded = override ?? (isLastTurn && options.running)
    const group: ProcessGroupItem = {
      kind: 'process-group',
      id: turn.id,
      items: processItems,
      toolCallCount: processItems.filter((item) => item.kind === 'tool-row').length,
      messageCount: processItems.length,
      collapsed: !expanded,
    }

    // 组放在首个过程消息的位置；白名单成员保持原始相对位置
    let groupPlaced = false
    for (const item of turn.items) {
      if (processItems.includes(item)) {
        if (!groupPlaced) {
          output.push(group)
          groupPlaced = true
        }
        continue
      }
      output.push(item)
    }
  })

  return output
}
