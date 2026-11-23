/**
 * 计划位置选择器的纯逻辑（作者字段控制权计划阶段 2）：模式集合、编码 ↔ 模式
 * 推断、相对位置输入的即时校验与展示文本。组件保持薄壳，规则在此可单测。
 */
import { parsePlannedPosition } from '@novai/core/services/foreshadowing-service'

/** 选择器的模式：兼容原文（raw）作为独立模式展示，不参与正常新建 */
export type PlannedPickerMode = 'none' | 'chapter' | 'relative' | 'future' | 'open' | 'raw'

/** 终点允许开放终点；起点以「未设置」收尾（清空起点即清空整个窗口） */
export function pickerModes(allowOpen: boolean): Array<{ value: PlannedPickerMode; label: string }> {
  return [
    ...(allowOpen ? [] : ([{ value: 'none', label: '未设置' }] as const)),
    { value: 'chapter', label: '已有章节' },
    { value: 'relative', label: '最新章节之后第 N 章' },
    { value: 'future', label: '指定未来章号' },
    ...(allowOpen ? ([{ value: 'open', label: '开放终点（暂无截止章）' }] as const) : []),
  ]
}

/** 由编码值推断当前模式；空串按未设置 */
export function modeFromEncoded(value: string): PlannedPickerMode {
  const parsed = parsePlannedPosition(value)
  if (parsed === null) {
    return 'none'
  }
  return parsed.kind
}

/**
 * 相对位置输入校验：基准与偏移都必须是正整数（计划 §三.5：偏移量必须为正
 * 整数；记录当时的基准章号与偏移量）。目标 = 基准 + 偏移在保存时确定。
 */
export function validateRelativeInput(base: number | null, offset: number | null): { ok: true; target: number } | { ok: false; message: string } {
  if (base === null || !Number.isInteger(base) || base < 1) {
    return { ok: false, message: '基准章号须为正整数' }
  }
  if (offset === null || !Number.isInteger(offset) || offset < 1) {
    return { ok: false, message: '偏移量须为正整数（至少 1 章）' }
  }
  return { ok: true, target: base + offset }
}

/** 相对位置展示：基准、偏移与已确定的目标章号（保存后不随最新章节漂移） */
export function relativeSummary(base: number | null, offset: number | null): string {
  const result = validateRelativeInput(base, offset)
  return result.ok
    ? `第${base}章之后 ${offset} 章 → 第${result.target}章（基准已固定）`
    : '待补基准章号与偏移量'
}

/** 未来章号输入校验：正整数即可，允许指向编号空隙中未创建的章号 */
export function validateFutureInput(target: number | null): { ok: true; target: number } | { ok: false; message: string } {
  if (target === null || !Number.isInteger(target) || target < 1) {
    return { ok: false, message: '章号须为正整数' }
  }
  return { ok: true, target }
}
