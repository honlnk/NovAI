import { hashContent } from '../util/hash'
import {
  insertAfterLeadingReminders,
  insertAfterSystem,
  replaceMessage,
  type ModelView,
} from '../agent/model-view'
import type { AgentMessage } from '../agent/messages'
import type { ChatSessionState } from '../../types/chat'

/**
 * 渐进式披露 L1 的公共目录 reminder 通道（《技能包底层能力施工计划》决策 1）：
 * 把「空目录不注入 / 首注 / digest 未变跳过 / 变化原地替换 / 压缩吞掉后重注」
 * 的注入机制从要素（element-catalog-reminder）抽为公共组件，要素与技能共用。
 *
 * 边界：只收编注入通道与 digest 归一算法；扫描、解析、L2/L3 加载各领域各写各的。
 */

/** reminder 的插入位置：'after-system' = 紧跟 system（现有默认）；'after-leading-reminders' = system 之后连续 reminder 块的末尾。 */
export type CatalogPlacement = 'after-system' | 'after-leading-reminders'

/**
 * 一条目录通道的声明：领域（要素/技能）只声明自己的渲染、digest 与会话字段，
 * 注入机制（findIndex/替换/重插/digest 比对）全部由 syncCatalogReminder 承担。
 * 会话 digest 存储按通道各自声明字段（决策 2），零数据迁移。
 */
export type CatalogChannel<E> = {
  /** reminder 的存在标记（首注/更新两版文案都含，用于视图内检测）：各通道互不相同的标签。 */
  marker: string
  /** 目录条目 → reminder 全文（isUpdate 区分首注/更新版文案）。 */
  render(entries: readonly E[], options: { isUpdate: boolean }): string
  /** 目录条目 → digest（敏感面由领域定义，如要素的 name+summary、技能的 name+展示描述）。 */
  digestOf(entries: readonly E[]): string
  /** 会话 digest 字段的读/写（通道各自声明字段，如 elementCatalogDigest / skillCatalogDigest）。 */
  readDigest(session: ChatSessionState): string | undefined
  writeDigest(session: ChatSessionState, digest: string): void
  /** 插入位置；缺省 'after-system'（与既有三条 reminder 的行为一致）。 */
  placement?: CatalogPlacement
}

/**
 * 目录 digest 归一工具（决策 1）：条目先按领域 comparator 稳定排序（枚举顺序归一，
 * digest 与渲染都不抖动），再投影为规范字符串，join 后整体 hash。
 * 原 digestElementCatalog 的算法原样搬入；导出与结果不变（新旧机制替代表）。
 */
export function digestCatalogEntries<E>(
  entries: readonly E[],
  options: {
    compare(a: E, b: E): number
    project(entry: E): string
  },
): string {
  const canonical = [...entries]
    .sort(options.compare)
    .map(options.project)
    .join('\n')
  return hashContent(canonical)
}

/**
 * 目录 reminder 的 digest 按需注入（机制与 syncNovaiReminder / syncConstraintDocReminder 对齐）：
 * 空目录不注入；首轮、目录变化、或被压缩吞掉后（重）注入。reminder 恒为视图中
 * 唯一一条——变化时原地替换。写入成功后更新会话 digest 字段。
 */
export function syncCatalogReminder<E>(input: {
  view: ModelView
  session: ChatSessionState
  entries: readonly E[]
  channel: CatalogChannel<E>
}): void {
  if (input.entries.length === 0) {
    return
  }

  const digest = input.channel.digestOf(input.entries)
  const existingIndex = input.view.messages.findIndex(
    (message) => message.role === 'user' && message.content.includes(input.channel.marker),
  )
  if (existingIndex >= 0 && digest === input.channel.readDigest(input.session)) {
    return
  }

  const reminder: AgentMessage = {
    role: 'user',
    content: input.channel.render(input.entries, { isUpdate: existingIndex >= 0 }),
  }
  if (existingIndex >= 0) {
    replaceMessage(input.view, existingIndex, reminder)
  } else if ((input.channel.placement ?? 'after-system') === 'after-leading-reminders') {
    insertAfterLeadingReminders(input.view, reminder)
  } else {
    insertAfterSystem(input.view, reminder)
  }
  input.channel.writeDigest(input.session, digest)
}
