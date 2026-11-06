import { describe, expect, it } from 'vitest'

import {
  panelCloseTarget,
  resolveWorkspacePanel,
  type WorkspacePanelInput,
} from './workspace-panel'

/** 基线：文件面板开、有文件；计划面板开、有详情；当前在章节分类 */
function baseInput(overrides: Partial<WorkspacePanelInput> = {}): WorkspacePanelInput {
  return {
    category: 'chapter',
    isFilePanelOpen: true,
    hasFileContent: true,
    isPlanPanelOpen: true,
    isCreateOpen: false,
    hasActiveCard: true,
    ...overrides,
  }
}

describe('resolveWorkspacePanel 面板归属与显示规则（布局统一计划 §2）', () => {
  it('进入计划分类：无选中详情且未新建时默认收起（D10）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: false,
      hasActiveCard: false,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('计划分类点击卡片展开详情（D2）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: true,
      hasActiveCard: true,
    }))
    expect(state).toEqual({ visible: true, kind: 'plan-detail' })
  })

  it('计划分类新建与详情互斥：新建优先展示（D3）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: true,
      isCreateOpen: true,
      hasActiveCard: true,
    }))
    expect(state).toEqual({ visible: true, kind: 'plan-create' })
  })

  it('计划分类偏好开但详情与新建都清空后收起（不悬挂空面板）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: true,
      isCreateOpen: false,
      hasActiveCard: false,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('计划分类偏好关（面板被收起）时即使详情仍在也不展示（§2.8 关闭只影响可见性）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: false,
      hasActiveCard: true,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('文件分类：偏好开且有文件内容时展示文件（D2）', () => {
    const state = resolveWorkspacePanel(baseInput({ category: 'chapter' }))
    expect(state).toEqual({ visible: true, kind: 'file' })
  })

  it('文件分类：此前未打开文件时不凭空显示空面板（§2.5）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'chapter',
      hasFileContent: false,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('文件分类偏好关时收起，即使文件仍打开', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'prompt',
      isFilePanelOpen: false,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('跨分类恢复：计划开着详情切到章节显示文件，切回计划恢复详情（§2.3/§2.5）', () => {
    const onPlan = resolveWorkspacePanel(baseInput({ category: 'plan' }))
    expect(onPlan).toEqual({ visible: true, kind: 'plan-detail' })

    // 切到章节：文件偏好与内容保留 → 恢复文件面板；计划状态不受影响
    const onChapter = resolveWorkspacePanel(baseInput({ category: 'chapter' }))
    expect(onChapter).toEqual({ visible: true, kind: 'file' })

    const backOnPlan = resolveWorkspacePanel(baseInput({ category: 'plan' }))
    expect(backOnPlan).toEqual({ visible: true, kind: 'plan-detail' })
  })

  it('跨分类恢复：计划开着新建切到章节再切回，仍展示新建（§2.3）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isCreateOpen: true,
    }))
    expect(state).toEqual({ visible: true, kind: 'plan-create' })

    const onChapter = resolveWorkspacePanel(baseInput({ category: 'chapter' }))
    expect(onChapter).toEqual({ visible: true, kind: 'file' })

    const backOnPlan = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isCreateOpen: true,
    }))
    expect(backOnPlan).toEqual({ visible: true, kind: 'plan-create' })
  })

  it('计划页不展示其他分类的文件（D11）：计划分类下文件内容存在也不算数', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: false,
      hasActiveCard: false,
      isFilePanelOpen: true,
      hasFileContent: true,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })

  it('项目切换清理：计划状态全部清空后面板收起（§2.6）', () => {
    const state = resolveWorkspacePanel(baseInput({
      category: 'plan',
      isPlanPanelOpen: true,
      isCreateOpen: false,
      hasActiveCard: false,
    }))
    expect(state).toEqual({ visible: false, kind: null })
  })
})

describe('panelCloseTarget 关闭收敛目标', () => {
  it('文件内容关闭收敛文件偏好', () => {
    expect(panelCloseTarget('file')).toBe('file')
  })

  it('计划详情/新建关闭收敛计划偏好', () => {
    expect(panelCloseTarget('plan-detail')).toBe('plan')
    expect(panelCloseTarget('plan-create')).toBe('plan')
  })

  it('面板本就收起时不动作', () => {
    expect(panelCloseTarget(null)).toBeNull()
  })
})
