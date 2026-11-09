import type { Category } from '../constants/category'

/**
 * 工作区右侧面板归属规则（布局统一计划 D2/D3/D10/D11，§2.2/§2.3/§2.5；
 * 创作心智模块将同构规则扩展到伏笔分类）。
 *
 * 统一规则：左侧导航与选择，中间当前分类的主任务，右侧查看/编辑当前选中内容。
 * 右侧面板按分类与当前任务展示：普通文件 / 看板卡片详情（计划、伏笔）/ 新建。
 * 展开偏好按「文件」「计划」「伏笔」「节奏」四路各自保留：切换分类只影响可见性，不清
 * 内容——返回原分类时恢复离开前的展开状态（§2.5），未选中内容时不得凭空显示
 * 空面板。
 */

export type WorkspacePanelKind =
  | 'file'
  | 'plan-detail'
  | 'plan-create'
  | 'foreshadowing-detail'
  | 'foreshadowing-create'
  | 'rhythm-detail'
  | 'rhythm-create'
  | 'write-confirm'

export type WorkspacePanelInput = {
  category: Category
  /** 普通文件面板的展开偏好（跨分类保留） */
  isFilePanelOpen: boolean
  /** 有可展示的文件内容（activeFile 或删除空态提示） */
  hasFileContent: boolean
  /** 计划面板的展开偏好（跨分类保留） */
  isPlanPanelOpen: boolean
  /** 新建面板开启（与详情互斥展示，优先级高于详情） */
  isCreateOpen: boolean
  /** 有选中的计划详情 */
  hasActiveCard: boolean
  /** 伏笔面板的展开偏好（跨分类保留；缺省 false 兼容旧调用方） */
  isForeshadowingPanelOpen?: boolean
  /** 伏笔新建面板开启（与详情互斥展示，优先级高于详情） */
  isForeshadowingCreateOpen?: boolean
  /** 有选中的伏笔详情 */
  hasActiveForeshadowing?: boolean
  /** 节奏面板的展开偏好（跨分类保留；缺省 false 兼容旧调用方） */
  isRhythmPanelOpen?: boolean
  /** 节奏新建面板开启（与详情互斥展示，优先级高于详情） */
  isRhythmCreateOpen?: boolean
  /** 有选中的节奏卡详情 */
  hasActiveRhythm?: boolean
}

export type WorkspacePanelState = {
  visible: boolean
  kind: WorkspacePanelKind | null
}

/**
 * 计算右侧面板当前应展示的内容与可见性。
 * - 看板类分类（计划/伏笔）：面板收起偏好关、或既无详情也无新建 → 收起（进入
 *   分类默认收起，D10）；新建开启时展示新建（D3 互斥），否则有详情展示详情（D2）。
 * - 其余分类：偏好开且有文件内容才展示；此前未打开文件不得凭空显示空面板（§2.5）。
 */
export function resolveWorkspacePanel(input: WorkspacePanelInput): WorkspacePanelState {
  if (input.category === 'plan') {
    if (!input.isPlanPanelOpen) {
      return { visible: false, kind: null }
    }
    if (input.isCreateOpen) {
      return { visible: true, kind: 'plan-create' }
    }
    if (input.hasActiveCard) {
      return { visible: true, kind: 'plan-detail' }
    }
    return { visible: false, kind: null }
  }

  if (input.category === 'foreshadowing') {
    if (!input.isForeshadowingPanelOpen) {
      return { visible: false, kind: null }
    }
    if (input.isForeshadowingCreateOpen) {
      return { visible: true, kind: 'foreshadowing-create' }
    }
    if (input.hasActiveForeshadowing) {
      return { visible: true, kind: 'foreshadowing-detail' }
    }
    return { visible: false, kind: null }
  }

  if (input.category === 'rhythm') {
    if (!input.isRhythmPanelOpen) {
      return { visible: false, kind: null }
    }
    if (input.isRhythmCreateOpen) {
      return { visible: true, kind: 'rhythm-create' }
    }
    if (input.hasActiveRhythm) {
      return { visible: true, kind: 'rhythm-detail' }
    }
    return { visible: false, kind: null }
  }

  if (!input.isFilePanelOpen || !input.hasFileContent) {
    return { visible: false, kind: null }
  }
  return { visible: true, kind: 'file' }
}

/**
 * 面板关闭入口按当前展示内容收敛对应分类的展开偏好（§2.8 关闭只影响可见性）。
 * 返回需要置 false 的偏好位；面板本就收起（kind null）时不动任何状态。
 */
export function panelCloseTarget(
  kind: WorkspacePanelKind | null,
): 'file' | 'plan' | 'foreshadowing' | 'rhythm' | 'write-confirm' | null {
  if (kind === 'file') {
    return 'file'
  }
  if (kind === 'plan-detail' || kind === 'plan-create') {
    return 'plan'
  }
  if (kind === 'foreshadowing-detail' || kind === 'foreshadowing-create') {
    return 'foreshadowing'
  }
  if (kind === 'rhythm-detail' || kind === 'rhythm-create') {
    return 'rhythm'
  }
  if (kind === 'write-confirm') {
    return 'write-confirm'
  }
  return null
}
