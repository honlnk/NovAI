import { digestElementCatalog } from '../elements/catalog'
import { insertAfterSystem, replaceMessage, type ModelView } from './model-view'
import type { AgentMessage } from './messages'
import type { ChatSessionState } from '../../types/chat'
import type { ElementCatalogEntry } from '../../types/elements'
import type { ElementType } from '../../types/rag'

/**
 * 要素目录 reminder（渐进式披露 L1，决策 0007）：四类稳定要素的 type + name + summary
 * 清单，以 user-role `<system-reminder>` 紧跟 system 注入；digest 驱动原位替换，
 * 机制完全对齐 syncNovaiReminder / syncConstraintDocReminder。
 */

/** 目录 reminder 的存在标记：首注/更新两版文案都含此标签，用于视图内检测。 */
const ELEMENT_CATALOG_REMINDER_MARKER = '<available_elements>'

/** 目录行的类型标签（渲染顺序即 catalog.ts 的类型分组序）。 */
const TYPE_LABELS: Record<ElementType, string> = {
  character: '角色',
  location: '地点',
  entity: '实体',
  worldbuilding: '世界观',
  plot: '剧情',
  timeline: '时间线',
}

export function buildElementCatalogReminder(
  entries: readonly ElementCatalogEntry[],
  options: { isUpdate: boolean },
): string {
  const head = options.isUpdate
    ? '以下是最新的本书要素清单（角色/地点/实体/世界观设定），按类型分组，取代此前任何版本。'
    : '以下是本书的要素清单（角色/地点/实体/世界观设定），按类型分组。'
  const lines = entries.map((entry) => {
    const label = TYPE_LABELS[entry.type] ?? entry.type
    return `- [${label}] ${entry.name} — ${entry.summary}`
  })

  return [
    '<system-reminder>',
    head,
    '',
    '<available_elements>',
    ...lines,
    '</available_elements>',
    '',
    '当你需要使用某个要素的完整定义时，调用 LoadElements 工具并传入其名称。本清单只包含摘要，不要在未加载完整定义前凭空推断要素细节。',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 要素目录 digest 按需注入：空目录不注入；首轮、要素集变化、或被压缩吞掉后
 * 在 system 之后（重）注入。reminder 恒为视图中唯一一条——变化时原地替换。
 * digest 只覆盖 name + summary（决策 0007 决策二），要素正文变化不触发重发。
 */
export function syncElementCatalogReminder(input: {
  view: ModelView
  session: ChatSessionState
  entries: readonly ElementCatalogEntry[]
}): void {
  if (input.entries.length === 0) {
    return
  }

  const digest = digestElementCatalog(input.entries)
  const existingIndex = input.view.messages.findIndex(
    (message) => message.role === 'user' && message.content.includes(ELEMENT_CATALOG_REMINDER_MARKER),
  )
  if (existingIndex >= 0 && digest === input.session.elementCatalogDigest) {
    return
  }

  const reminder: AgentMessage = {
    role: 'user',
    content: buildElementCatalogReminder(input.entries, { isUpdate: existingIndex >= 0 }),
  }
  if (existingIndex >= 0) {
    replaceMessage(input.view, existingIndex, reminder)
  } else {
    insertAfterSystem(input.view, reminder)
  }
  input.session.elementCatalogDigest = digest
}
