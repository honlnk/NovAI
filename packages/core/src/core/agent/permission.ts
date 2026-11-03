import { normalizeProjectPath } from '../tools/path'
import { DEFAULT_PERMISSION_PRESET, isPermissionPreset } from '../project/defaults'
import type { PermissionPreset, ProjectSnapshot } from '../../types/project'

/**
 * 写工具权限五档（替代「工作区内一律静默放行」的单一范围策略）：
 * 用户选一个档位，控制「哪些修改不需要每次弹确认卡」。
 *
 * 判定按「动作 + 路径」双重进行：
 * - 内容修改（EditFile 改正文）：看路径——chapters/ 走章节档、elements/ 与 plans/ 走素材档；
 * - 结构操作（CreateFile/DeleteFile/RenameFile、CreatePlan/DeletePlan）：除「完全访问」外一律弹卡，
 *   不管操作对象是不是章节/素材（移动即改名，RenameFile 归结构操作）；
 * - UpdatePlan 不改变文件位置与存在性（状态/顺序在 frontmatter 里），按素材内容档处理；
 * - 「仅审阅」不是拒绝：弹卡询问，批一次改一次（无 always-allow）。
 *
 * 硬底线不在此层：.novel/ 写保护、novel.config.json 保护、chapters 命名规范等
 * 仍在工具校验层（tools/file-tools/common.ts、tools/path.ts），任何档位都不例外。
 */

/** 权限档位类型与默认值统一来自 types/project.ts 与 project/defaults.ts（config 持久化口径）。 */
export type { PermissionPreset } from '../../types/project'
export { DEFAULT_PERMISSION_PRESET, isPermissionPreset, PERMISSION_PRESETS } from '../project/defaults'

export type PermissionDecision =
  /** 当前档位免确认，静默放行 */
  | { kind: 'allow' }
  /** 当前档位需用户确认（仅此一次） */
  | { kind: 'ask'; reason: string }

/** 授权结果词表（照抄 dsh）：没有 always-allow，授权永远一次性。 */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'

/** 写动作分类：EditFile/UpdatePlan=内容修改；结构操作与计划新建/删除归 structure。 */
type WriteAction = 'content-edit' | 'structure'

/** 结构操作工具集：新建/删除/重命名（含计划卡片的新建与删除）。 */
const STRUCTURE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'CreateFile',
  'DeleteFile',
  'RenameFile',
  'CreatePlan',
  'DeletePlan',
])

function classifyWriteAction(toolName: string): WriteAction {
  return STRUCTURE_TOOL_NAMES.has(toolName) ? 'structure' : 'content-edit'
}

/** 档位是否覆盖 chapters/ 正文修改。 */
function presetCoversChapters(preset: PermissionPreset) {
  return preset === 'chapter' || preset === 'chapter-material' || preset === 'full'
}

/** 档位是否覆盖 elements/ 素材修改（六个子目录都算素材）。 */
function presetCoversMaterials(preset: PermissionPreset) {
  return preset === 'material' || preset === 'chapter-material' || preset === 'full'
}

/**
 * 对写工具的已校验 input 做整体决策：先取当前档位（持久化在 config.settings.permissionPreset，
 * 旧配置由 normalizeProjectConfig 回填默认值），再按「动作 + 路径」规则判定 allow/ask。
 */
export function decideWriteToolPermission(
  toolName: string,
  validatedInput: unknown,
  project: ProjectSnapshot,
): PermissionDecision {
  const preset = readPermissionPreset(project)

  // 计划专用工具以稳定标识定位（input 无 path 字段），单独判定：
  // - CreatePlan/DeletePlan 走结构确认（改变文件存在性）；仅「完全访问」免确认；
  // - UpdatePlan 只改 frontmatter 元数据/正文，不改变文件位置与存在性，按素材档处理。
  if (toolName === 'CreatePlan' || toolName === 'DeletePlan') {
    if (preset === 'full') {
      return { kind: 'allow' }
    }
    return {
      kind: 'ask',
      reason: '新建/删除计划属于结构操作，当前档位需逐次确认（仅「完全访问」档免确认）',
    }
  }

  if (toolName === 'UpdatePlan') {
    if (preset === 'full') {
      return { kind: 'allow' }
    }
    if (preset === 'review') {
      return { kind: 'ask', reason: '当前权限档位为「仅审阅」，任何修改都需逐次确认' }
    }
    if (presetCoversMaterials(preset)) {
      return { kind: 'allow' }
    }
    return { kind: 'ask', reason: '修改计划属于素材类内容，当前档位需逐次确认（「素材内容」「章节与素材」「完全访问」档免确认）' }
  }

  const paths = collectPathFields(validatedInput)

  if (paths.length === 0) {
    // 已通过工具校验却没有路径字段（异常情况），保守确认
    return { kind: 'ask', reason: `无法从 ${toolName} 的参数中取得写入路径` }
  }

  // 路径仍须能规范化为项目内相对路径（防御性复核；工具校验层已拦过一轮）
  for (const path of paths) {
    try {
      normalizeProjectPath(path)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '路径不合法'
      return { kind: 'ask', reason: `写入路径无法规范化为项目内相对路径：${reason}` }
    }
  }

  if (preset === 'full') {
    return { kind: 'allow' }
  }

  if (preset === 'review') {
    return { kind: 'ask', reason: '当前权限档位为「仅审阅」，任何修改都需逐次确认' }
  }

  if (classifyWriteAction(toolName) === 'structure') {
    return {
      kind: 'ask',
      reason: '新建/删除/重命名属于结构操作，当前档位需逐次确认（仅「完全访问」档免确认）',
    }
  }

  // 内容修改：按路径归属判定（任一路径不在免确认范围内，整体 ask——最严者胜）
  for (const path of paths) {
    if (path.startsWith('chapters/') && presetCoversChapters(preset)) {
      continue
    }
    if ((path.startsWith('elements/') || path.startsWith('plans/')) && presetCoversMaterials(preset)) {
      continue
    }
    return {
      kind: 'ask',
      reason: `修改 ${path} 不在当前档位的免确认范围内（章节档管 chapters/、素材档管 elements/ 与 plans/，提示词与配置类文件总是需确认）`,
    }
  }

  return { kind: 'allow' }
}

/** 从项目配置读当前档位；配置缺字段/非法值时回退默认档（双保险，正常已被 normalize 回填）。 */
function readPermissionPreset(project: ProjectSnapshot): PermissionPreset {
  const value = project.config?.settings?.permissionPreset
  return isPermissionPreset(value) ? value : DEFAULT_PERMISSION_PRESET
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
