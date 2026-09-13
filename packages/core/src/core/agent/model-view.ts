import type { AgentAssistantMessage, AgentMessage, AgentToolResultMessage } from './messages'

/**
 * 模型视图（ModelView）：发给 LLM 的当前消息序列的唯一来源。
 *
 * 与显示层 ChatMessage[] 彻底分离：
 * - 显示层是全量 transcript（UI 展示 + 完整持久化），一字不动；
 * - 模型层是发给 LLM 的当前视图，支持「区间替换」压缩（compaction），
 *   会话 JSON 里持久化的是这个视图压缩后的样子，而不是全量历史。
 */
export type ModelView = {
  messages: AgentMessage[]
}

export function createModelView(messages: AgentMessage[] = []): ModelView {
  return { messages: [...messages] }
}

export function appendUserMessage(view: ModelView, content: string): void {
  view.messages = [...view.messages, { role: 'user', content }]
}

export function appendAssistantMessage(view: ModelView, message: AgentAssistantMessage): void {
  view.messages = [...view.messages, message]
}

export function appendToolResults(view: ModelView, results: AgentToolResultMessage[]): void {
  view.messages = [...view.messages, ...results]
}

/**
 * 把 [startIdx, endIdx]（含两端）的消息区间替换为一条摘要消息——上下文压缩的落地原语。
 * 区间非法时抛错：调用方（compaction）必须先算出合法区间，这里不做静默容错。
 */
export function replaceRangeWithSummary(
  view: ModelView,
  startIdx: number,
  endIdx: number,
  summaryMessage: AgentMessage,
): void {
  if (
    !Number.isInteger(startIdx)
    || !Number.isInteger(endIdx)
    || startIdx < 0
    || endIdx < startIdx
    || endIdx >= view.messages.length
  ) {
    throw new Error(`非法的压缩区间：[${startIdx}, ${endIdx}]（当前共 ${view.messages.length} 条消息）`)
  }

  view.messages = [
    ...view.messages.slice(0, startIdx),
    summaryMessage,
    ...view.messages.slice(endIdx + 1),
  ]
}

/**
 * 写入/刷新 system message。system message 恒在 index 0（query 循环只追加 assistant/tool，
 * 从不新增 system）：已是 system 则替换 content，否则（首轮空视图）插入头部。
 */
export function setSystemMessage(view: ModelView, content: string): void {
  if (view.messages[0]?.role === 'system') {
    view.messages = [{ ...view.messages[0], content }, ...view.messages.slice(1)]
    return
  }
  view.messages = [{ role: 'system', content }, ...view.messages]
}

/** 产出最终发给模型的 messages 数组（防御性拷贝，调用方改动不影响视图）。 */
export function toRequestMessages(view: ModelView): AgentMessage[] {
  return [...view.messages]
}

/** 每条消息的结构开销（role/字段封装等），参照常见 token 估算惯例。 */
const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * 估算整个视图发给模型时的 token 量。
 * 只用于压缩阈值判断，不需要精确——稳定、单调、量级正确即可。
 */
export function estimateTokens(view: ModelView): number {
  let total = 0

  for (const message of view.messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content)
    if (message.role === 'assistant' && message.toolCalls?.length) {
      total += estimateTextTokens(JSON.stringify(message.toolCalls))
    }
  }

  return total
}

/**
 * 文本 token 启发式：CJK 字符按 1 token 计，其余按 ceil(len / 4)。
 *
 * dsh 的 chars/4 对中文正文的低估约 4 倍（4000 字章节实际约 4000 token），
 * 小说场景的上下文几乎全是中文，必须分治，否则压缩阈值会偏离预期数倍。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let rest = 0

  for (const char of text) {
    if (CJK_CHAR_PATTERN.test(char)) {
      cjk += 1
    } else {
      rest += 1
    }
  }

  return cjk + Math.ceil(rest / 4)
}

// CJK 统一表意文字（含扩展 A 与兼容区）、CJK 符号标点（。、「」等）、日文假名、韩文音节、全角标点
const CJK_CHAR_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/
