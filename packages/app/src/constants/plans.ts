import type { PlanStatusView } from '@novai/core/services/types'

/** 看板列定义：常驻四栏 + 已搁置（筛选可见）。顺序即展示顺序。 */
export const PLAN_COLUMN_LABELS: Record<PlanStatusView, string> = {
  'inbox': '收集箱',
  'planned': '计划中',
  'in-progress': '进行中',
  'done': '已完成',
  'on-hold': '已搁置',
}

export function planStatusLabel(status: PlanStatusView): string {
  return PLAN_COLUMN_LABELS[status]
}
