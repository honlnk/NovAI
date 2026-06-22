import type { ProjectIndexMeta } from '../../types/rag'

/**
 * RAG 索引状态变化事件总线。
 *
 * 独立于 AgentUiEvent——后者是 Agent Loop 专用通道，而索引状态变化可能来自
 * 要素写入、手动重建等多条非 Agent 路径。用独立的 EventTarget 跨 service 传播，
 * 让 app 层能在任意路径下感知到 status / documentCount 的变化。
 */

const EVENT_TYPE = 'rag-index-change'

class RagIndexChangeEvent extends Event {
  readonly projectId: string
  readonly meta: ProjectIndexMeta

  constructor(projectId: string, meta: ProjectIndexMeta) {
    super(EVENT_TYPE)
    this.projectId = projectId
    this.meta = meta
  }
}

const target = new EventTarget()

/**
 * 在索引 meta 被写入（构建完成 / 标记 stale / 构建失败）后调用，
 * 通知订阅者刷新状态。
 */
export function dispatchIndexChange(projectId: string, meta: ProjectIndexMeta): void {
  target.dispatchEvent(new RagIndexChangeEvent(projectId, meta))
}

/**
 * 订阅某个项目的索引状态变化。回调只在该 projectId 的事件时触发。
 * 返回取消订阅函数。
 */
export function onRagIndexChange(
  projectId: string,
  callback: (meta: ProjectIndexMeta) => void,
): () => void {
  const listener = (event: Event) => {
    const custom = event as RagIndexChangeEvent
    if (custom.projectId === projectId) {
      callback(custom.meta)
    }
  }

  target.addEventListener(EVENT_TYPE, listener)
  return () => target.removeEventListener(EVENT_TYPE, listener)
}
