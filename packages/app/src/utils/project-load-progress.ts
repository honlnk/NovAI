import type { ProjectLoadPhase, ProjectLoadProgress } from '@novai/core/types/project'

/** 打开类动作的种类：决定进度面板的标题与阶段文案。 */
export type ProjectLoadAction = 'create' | 'open' | 'restore'

/** 小说页载入工作区阶段：核心层不报，由应用层在打开成功后接管。 */
export type WorkspaceLoadPhase = 'workspace'

export type ProjectLoadPhaseView = ProjectLoadPhase | WorkspaceLoadPhase

export type ProjectLoadProgressView = {
  action: ProjectLoadAction
  phase: ProjectLoadPhaseView
  /** 总进度（0–100），已取整。 */
  percent: number
  current?: number
  total?: number
  files?: number
  directories?: number
  currentPath?: string
  projectName?: string
}

/**
 * 各阶段在总进度里占的区间。等待授权、扫描文件、载入工作区没有可知的比例，
 * 停在区间起点；检查项目结构与即将完成按步数比例前进。
 * 载入工作区不由核心层上报（小说页用 `isWorkspaceLoading` 单独表达），区间只用来
 * 说明进度条最后 10% 属于它——打开类动作结束时进度条停在 90。
 */
const PHASE_RANGES: Record<ProjectLoadPhaseView, readonly [number, number]> = {
  permission: [0, 3],
  structure: [3, 33],
  scan: [33, 83],
  activate: [83, 90],
  workspace: [90, 100],
}

export function getPhaseRange(phase: ProjectLoadPhaseView): readonly [number, number] {
  return PHASE_RANGES[phase]
}

/** 把核心层的一次进度事件换算成界面用的进度视图。 */
export function toLoadProgressView(
  action: ProjectLoadAction,
  progress: ProjectLoadProgress | { phase: WorkspaceLoadPhase },
): ProjectLoadProgressView {
  const [start, end] = PHASE_RANGES[progress.phase]
  const ratio = 'current' in progress && progress.current !== undefined && progress.total
    ? clamp(progress.current / progress.total, 0, 1)
    : 0

  return {
    ...progress,
    action,
    percent: Math.round(start + (end - start) * ratio),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** 小说页进入时的去向：进入工作区 / 停留本页等待授权 / 回首页。 */
export type ProjectEntryOutcome = 'workspace' | 'permission' | 'home'

/**
 * 判定小说页自动恢复的结果：恢复出的项目与路由一致才进入工作区；
 * 否则待授权提醒存在就留在本页出授权卡片，其余情况（没有记录、目录被删等）回首页。
 */
export function resolveProjectEntryOutcome(
  restored: { id: string } | null,
  routeProjectId: string,
  notice: { kind: string } | null,
): ProjectEntryOutcome {
  if (restored && restored.id === routeProjectId) {
    return 'workspace'
  }
  if (notice?.kind === 'permission') {
    return 'permission'
  }
  return 'home'
}
