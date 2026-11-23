import { describe, expect, it } from 'vitest'

import {
  getPhaseRange,
  resolveProjectEntryOutcome,
  toLoadProgressView,
} from './project-load-progress'

/**
 * 打开类动作的进度换算（《项目打开进度与移动端授权修复计划》§4）：
 * 各阶段在总进度里的区间固定，有步数的阶段按比例前进，没有的停在区间起点。
 */
describe('toLoadProgressView', () => {
  it('五个阶段的区间首尾相接，覆盖 0–100', () => {
    const phases = ['permission', 'structure', 'scan', 'activate', 'workspace'] as const

    expect(getPhaseRange(phases[0])[0]).toBe(0)
    for (const [index, phase] of phases.slice(1).entries()) {
      expect(getPhaseRange(phase)[0]).toBe(getPhaseRange(phases[index])[1])
    }
    expect(getPhaseRange('workspace')[1]).toBe(100)
  })

  it('等待授权停在 0；检查项目结构按步数比例从 3 走到 33', () => {
    expect(toLoadProgressView('restore', { phase: 'permission' })).toMatchObject({
      action: 'restore',
      phase: 'permission',
      percent: 0,
    })
    expect(toLoadProgressView('restore', { phase: 'structure', current: 0, total: 20 }).percent).toBe(3)
    expect(toLoadProgressView('restore', { phase: 'structure', current: 10, total: 20 }).percent).toBe(18)
    expect(toLoadProgressView('restore', { phase: 'structure', current: 20, total: 20 }).percent).toBe(33)
  })

  it('打开项目（29 步）与新建项目（21 步）各按自己的总步数换算', () => {
    expect(toLoadProgressView('open', { phase: 'structure', current: 9, total: 29 }).percent).toBe(12)
    expect(toLoadProgressView('open', { phase: 'structure', current: 29, total: 29 }).percent).toBe(33)
    expect(toLoadProgressView('create', { phase: 'structure', current: 18, total: 21 }).percent).toBe(29)
    expect(toLoadProgressView('create', { phase: 'structure', current: 21, total: 21 }).percent).toBe(33)
  })

  it('扫描文件停在 33，文件数、文件夹数与当前目录原样带出', () => {
    expect(toLoadProgressView('restore', {
      phase: 'scan',
      files: 37,
      directories: 14,
      currentPath: 'chapters',
    })).toEqual({
      action: 'restore',
      phase: 'scan',
      percent: 33,
      files: 37,
      directories: 14,
      currentPath: 'chapters',
    })
  })

  it('即将完成两步：87 → 90，第二步带项目名', () => {
    expect(toLoadProgressView('restore', { phase: 'activate', current: 1, total: 2 }).percent).toBe(87)
    expect(toLoadProgressView('restore', {
      phase: 'activate',
      current: 2,
      total: 2,
      projectName: '第一本小说',
    })).toEqual({
      action: 'restore',
      phase: 'activate',
      percent: 90,
      current: 2,
      total: 2,
      projectName: '第一本小说',
    })
  })

  it('载入工作区停在 90', () => {
    expect(toLoadProgressView('restore', { phase: 'workspace' }).percent).toBe(90)
  })

  it('步数缺失或总量为 0：停在阶段起点，不出 NaN', () => {
    expect(toLoadProgressView('restore', { phase: 'structure' }).percent).toBe(3)
    expect(toLoadProgressView('restore', { phase: 'structure', current: 3, total: 0 }).percent).toBe(3)
    expect(toLoadProgressView('restore', { phase: 'activate' }).percent).toBe(83)
  })

  it('步数越界：钳在阶段区间内', () => {
    expect(toLoadProgressView('restore', { phase: 'structure', current: 25, total: 20 }).percent).toBe(33)
    expect(toLoadProgressView('restore', { phase: 'structure', current: -1, total: 20 }).percent).toBe(3)
  })
})

describe('resolveProjectEntryOutcome', () => {
  it('恢复出的项目与路由一致：进入工作区（有待授权提醒也一样）', () => {
    expect(resolveProjectEntryOutcome({ id: 'p-1' }, 'p-1', null)).toBe('workspace')
    expect(resolveProjectEntryOutcome({ id: 'p-1' }, 'p-1', { kind: 'info' })).toBe('workspace')
  })

  it('恢复失败且有待授权提醒：留在本页等待授权', () => {
    expect(resolveProjectEntryOutcome(null, 'p-1', { kind: 'permission' })).toBe('permission')
  })

  it('没有记录、目录被删等其它情况：回首页', () => {
    expect(resolveProjectEntryOutcome(null, 'p-1', null)).toBe('home')
    expect(resolveProjectEntryOutcome(null, 'p-1', { kind: 'info' })).toBe('home')
  })

  it('恢复出的项目与路由不一致：以提醒为准，否则回首页', () => {
    expect(resolveProjectEntryOutcome({ id: 'p-other' }, 'p-1', null)).toBe('home')
    expect(resolveProjectEntryOutcome({ id: 'p-other' }, 'p-1', { kind: 'permission' })).toBe('permission')
  })
})
