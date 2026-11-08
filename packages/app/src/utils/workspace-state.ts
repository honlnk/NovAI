import type { Category } from '../constants/category'

/**
 * 按项目的工作区现场（交互优化计划 §3.4）：
 * 刷新、正常关闭重开和从首页恢复项目时恢复「上次分类、会话、文件、
 * 分类侧栏与内容/计划面板展开状态及面板宽度」。
 *
 * 只存浏览器 localStorage（key 前缀 `novai:workspace:`），不写入小说项目，
 * 也不进入模型上下文。旧会话/旧记录缺字段按缺省处理，不做批量迁移。
 */
export type WorkspaceState = {
  /** 上次停留的分类 */
  category: Category
  /** 上次激活的会话 id；null 表示上次没有激活会话（回退最近未归档） */
  activeSessionId: string | null
  /**
   * 上次激活的文件路径。区分两种「没有文件」：
   * - undefined：记录里没有该字段（旧记录），按「尚无恢复记录」的默认规则走
   * - null：用户明确没有选择文件，恢复时不得自动打开首文件
   */
  activeFilePath: string | null | undefined
  /** 分类侧栏展开 */
  categoryOpen: boolean
  /** 内容面板展开偏好 */
  contentPanelOpen: boolean
  /** 计划面板展开偏好 */
  planPanelOpen: boolean
  /** 伏笔面板展开偏好（旧记录缺省 false，与计划面板同构） */
  foreshadowingPanelOpen: boolean
  /** 内容面板宽度（clamp 后的合法值才写入） */
  contentPanelWidth?: number
}

const KEY_PREFIX = 'novai:workspace:'

/** 迁移来源：面板宽度在此前的全局 key 下，按项目记录缺宽度时回退读它。 */
export const LEGACY_CONTENT_PANEL_WIDTH_KEY = 'novai:contentPanelWidth'

const VALID_CATEGORIES: readonly Category[] = ['conversation', 'chapter', 'element', 'prompt', 'plan', 'foreshadowing']

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (VALID_CATEGORIES as readonly string[]).includes(value)
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

/**
 * 读取项目的恢复记录。无记录、JSON 损坏或形状不合法一律返回 null
 * （调用方按「尚无恢复记录」处理，使用现有默认选择）。
 */
export function loadWorkspaceState(projectId: string): WorkspaceState | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY_PREFIX + projectId)
  } catch {
    return null
  }
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const candidate = parsed as Record<string, unknown>
  if (!isCategory(candidate.category) || !isNullableString(candidate.activeSessionId)
    || !isNullableString(candidate.activeFilePath) || !isOptionalBoolean(candidate.categoryOpen)
    || !isOptionalBoolean(candidate.contentPanelOpen) || !isOptionalBoolean(candidate.planPanelOpen)
    || !isOptionalBoolean(candidate.foreshadowingPanelOpen)) {
    return null
  }

  const width = candidate.contentPanelWidth
  return {
    category: candidate.category,
    activeSessionId: candidate.activeSessionId ?? null,
    activeFilePath: candidate.activeFilePath,
    categoryOpen: candidate.categoryOpen ?? true,
    contentPanelOpen: candidate.contentPanelOpen ?? false,
    planPanelOpen: candidate.planPanelOpen ?? false,
    foreshadowingPanelOpen: candidate.foreshadowingPanelOpen ?? false,
    ...(typeof width === 'number' && Number.isFinite(width) ? { contentPanelWidth: width } : {}),
  }
}

/** 覆盖写项目的恢复记录；存储不可用（隐私模式等）时静默跳过。 */
export function saveWorkspaceState(projectId: string, state: WorkspaceState): void {
  try {
    localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(state))
  } catch {
    // 存储不可用时放弃持久化，不影响现场使用
  }
}

/** 读取旧全局面板宽度（迁移回退用）；无记录返回 null。 */
export function loadLegacyContentPanelWidth(): number | null {
  try {
    const raw = localStorage.getItem(LEGACY_CONTENT_PANEL_WIDTH_KEY)
    if (raw === null) {
      return null
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}
