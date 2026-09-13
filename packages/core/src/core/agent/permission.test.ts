import { describe, expect, it } from 'vitest'

import {
  decideWritePermission,
  decideWriteToolPermission,
  toApprovalOutcome,
} from './permission'
import type { ProjectSnapshot } from '../../types/project'

const stubProject = { handle: {} } as unknown as ProjectSnapshot

describe('decideWritePermission', () => {
  it('项目工作区内的相对路径静默放行', () => {
    expect(decideWritePermission('chapters/第001章-开头.txt', stubProject)).toEqual({ kind: 'allow' })
    expect(decideWritePermission('elements/characters/主角.md', stubProject)).toEqual({ kind: 'allow' })
    expect(decideWritePermission('prompts/system.md', stubProject)).toEqual({ kind: 'allow' })
  })

  it('绝对路径越界 → ask', () => {
    const decision = decideWritePermission('/etc/passwd', stubProject)
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') {
      expect(decision.reason).toContain('相对路径')
    }
  })

  it('Windows 盘符路径越界 → ask', () => {
    expect(decideWritePermission('C:/Windows/system32/config', stubProject).kind).toBe('ask')
  })

  it('.. 逃逸尝试 → ask', () => {
    expect(decideWritePermission('../项目外/敏感文件.md', stubProject).kind).toBe('ask')
    expect(decideWritePermission('chapters/../../逃逸.txt', stubProject).kind).toBe('ask')
  })

  it('空路径 → ask', () => {
    expect(decideWritePermission('   ', stubProject).kind).toBe('ask')
  })
})

describe('decideWriteToolPermission', () => {
  it('收集 path/fromPath/toPath 全部字段，任一越界整体 ask', () => {
    expect(decideWriteToolPermission(
      'RenameFile',
      { fromPath: 'chapters/001.txt', toPath: '../逃逸.txt' },
      stubProject,
    ).kind).toBe('ask')

    expect(decideWriteToolPermission(
      'RenameFile',
      { fromPath: 'chapters/001.txt', toPath: 'chapters/002.txt' },
      stubProject,
    )).toEqual({ kind: 'allow' })
  })

  it('无路径字段的异常 input 保守确认', () => {
    const decision = decideWriteToolPermission('CreateFile', { content: '内容' }, stubProject)
    expect(decision.kind).toBe('ask')
  })
})

describe('toApprovalOutcome', () => {
  it('授权永远一次性：accepted → allowed-once，拒绝 → rejected，无确认通道 → unavailable', () => {
    expect(toApprovalOutcome({ accepted: true })).toBe('allowed-once')
    expect(toApprovalOutcome({ accepted: false })).toBe('rejected')
    expect(toApprovalOutcome(null)).toBe('unavailable')
  })
})
