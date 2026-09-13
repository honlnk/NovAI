import { normalizeProjectPath } from '../tools/path'
import type { ProjectSnapshot } from '../../types/project'

/**
 * 范围权限（替代已删除的 regex tool-policy）：用范围策略替代每次确认，而非「记住选择」。
 *
 * - 写入目标在项目工作区内 → 静默放行；
 * - 越界（无法规范化为项目内相对路径）→ 弹一次确认；
 * - 授权永远一次性：没有 always-allow。
 *
 * 策略完全外置：工具不标危险等级，「要不要确认」由这一条独立决策判断。
 * `.novel/` 写保护、novel.config.json 保护、chapters 命名规范等硬安全仍在
 * 工具校验层（tools/path.ts），与「是否确认」无关。
 */

export type PermissionDecision =
  /** 工作区内，静默放行 */
  | { kind: 'allow' }
  /** 越界，需用户确认（仅此一次） */
  | { kind: 'ask'; reason: string }

/** 授权结果词表（照抄 dsh）：没有 always-allow，授权永远一次性。 */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'

/**
 * 判定一个写入路径是否落在项目工作区根内。
 *
 * NovAI 的工具路径本就被 normalizeProjectPath 约束为项目内相对路径（禁绝对路径与 `..`），
 * 所以绝大多数写天然 allow——本决策的实际效果是默认不再每次确认，只有异常路径才确认。
 */
export function decideWritePermission(path: string, project: ProjectSnapshot): PermissionDecision {
  // project 参数锚定「项目工作区根」语义：围栏始终相对当前项目，
  // 不接受任何绝对路径或越出根目录的相对路径。
  void project

  try {
    normalizeProjectPath(path)
    return { kind: 'allow' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '路径不合法'
    return { kind: 'ask', reason: `写入路径无法规范化为项目内相对路径：${reason}` }
  }
}

/**
 * 对写工具的已校验 input 做整体决策：收集其中全部路径字段（path / fromPath / toPath），
 * 任一字段越界则整体 ask（最严者胜）。
 */
export function decideWriteToolPermission(
  toolName: string,
  validatedInput: unknown,
  project: ProjectSnapshot,
): PermissionDecision {
  const paths = collectPathFields(validatedInput)

  if (paths.length === 0) {
    // 已通过工具校验却没有路径字段（异常情况），保守确认
    return { kind: 'ask', reason: `无法从 ${toolName} 的参数中取得写入路径` }
  }

  for (const path of paths) {
    const decision = decideWritePermission(path, project)
    if (decision.kind === 'ask') {
      return decision
    }
  }

  return { kind: 'allow' }
}

/** 确认回调结果 → 授权结果词表。 */
export function toApprovalOutcome(decision: { accepted: boolean } | null): ApprovalOutcome {
  if (decision === null) {
    return 'unavailable'
  }
  return decision.accepted ? 'allowed-once' : 'rejected'
}

function collectPathFields(validatedInput: unknown): string[] {
  if (!validatedInput || typeof validatedInput !== 'object') {
    return []
  }

  const record = validatedInput as Record<string, unknown>
  return ['path', 'fromPath', 'toPath']
    .filter((key) => typeof record[key] === 'string')
    .map((key) => record[key] as string)
}
