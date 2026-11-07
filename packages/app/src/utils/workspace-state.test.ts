import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadLegacyContentPanelWidth,
  loadWorkspaceState,
  saveWorkspaceState,
} from './workspace-state'

/**
 * 工作区现场恢复记录（§3.4）：按项目存 localStorage，损坏/缺字段/形状不合法
 * 一律按「尚无恢复记录」返回 null，不做批量迁移。
 */
describe('workspace-state', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('保存后按项目读回，字段完整', () => {
    saveWorkspaceState('p1', {
      category: 'plan',
      activeSessionId: 's1',
      activeFilePath: 'chapters/001.txt',
      categoryOpen: false,
      contentPanelOpen: true,
      planPanelOpen: true,
      contentPanelWidth: 480,
    })

    expect(loadWorkspaceState('p1')).toEqual({
      category: 'plan',
      activeSessionId: 's1',
      activeFilePath: 'chapters/001.txt',
      categoryOpen: false,
      contentPanelOpen: true,
      planPanelOpen: true,
      contentPanelWidth: 480,
    })
    // 按项目隔离：另一个项目读不到
    expect(loadWorkspaceState('p2')).toBeNull()
  })

  it('「用户明确没有选择文件」以 null 保存并原样读回', () => {
    saveWorkspaceState('p1', {
      category: 'chapter',
      activeSessionId: null,
      activeFilePath: null,
      categoryOpen: true,
      contentPanelOpen: false,
      planPanelOpen: false,
    })

    const state = loadWorkspaceState('p1')
    expect(state).not.toBeNull()
    expect(state!.activeFilePath).toBeNull()
    expect(state!.activeSessionId).toBeNull()
  })

  it('无记录返回 null（首次使用现有默认选择）', () => {
    expect(loadWorkspaceState('fresh')).toBeNull()
  })

  it('JSON 损坏返回 null，不抛错', () => {
    store.set('novai:workspace:p1', '{not json')
    expect(loadWorkspaceState('p1')).toBeNull()
  })

  it('形状不合法（未知分类）返回 null', () => {
    store.set('novai:workspace:p1', JSON.stringify({
      category: 'settings',
      activeSessionId: null,
      activeFilePath: null,
    }))
    expect(loadWorkspaceState('p1')).toBeNull()
  })

  it('缺省布尔字段读回为默认值（旧记录兼容）', () => {
    store.set('novai:workspace:p1', JSON.stringify({
      category: 'conversation',
      activeSessionId: 's9',
      activeFilePath: 'a.md',
    }))

    const state = loadWorkspaceState('p1')
    expect(state).toMatchObject({
      category: 'conversation',
      categoryOpen: true,
      contentPanelOpen: false,
      planPanelOpen: false,
    })
    expect(state!.contentPanelWidth).toBeUndefined()
  })

  it('存储不可用（抛错）时读取返回 null、保存静默跳过', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      },
    })
    expect(loadWorkspaceState('p1')).toBeNull()
    expect(() =>
      saveWorkspaceState('p1', {
        category: 'chapter',
        activeSessionId: null,
        activeFilePath: null,
        categoryOpen: true,
        contentPanelOpen: false,
        planPanelOpen: false,
      }),
    ).not.toThrow()
  })

  it('旧全局面板宽度可读取（迁移回退来源）', () => {
    expect(loadLegacyContentPanelWidth()).toBeNull()
    store.set('novai:contentPanelWidth', '512')
    expect(loadLegacyContentPanelWidth()).toBe(512)
    store.set('novai:contentPanelWidth', 'not-a-number')
    expect(loadLegacyContentPanelWidth()).toBeNull()
  })
})
