import { describe, expect, it } from 'vitest'

import {
  decideWriteToolPermission,
  toApprovalOutcome,
} from './permission'
import type { PermissionPreset, ProjectSnapshot } from '../../types/project'

function makeProject(preset?: PermissionPreset | string): ProjectSnapshot {
  return {
    handle: {},
    config: {
      settings: preset === undefined
        ? {} // 旧配置无 permissionPreset 字段：应回退默认档
        : { permissionPreset: preset },
    },
  } as unknown as ProjectSnapshot
}

describe('decideWriteToolPermission 档位读取', () => {
  it('旧配置缺字段回退默认档「章节 + 素材」：改章节/素材放行，改提示词要确认', () => {
    const project = makeProject()
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第003章-转折.txt' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'elements/characters/主角.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'prompts/NovAI.md' }, project).kind).toBe('ask')
  })

  it('非法档位值回退默认档', () => {
    const project = makeProject('nonsense')
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第003章-转折.txt' }, project)).toEqual({ kind: 'allow' })
  })

  it('无路径字段的异常 input 保守确认', () => {
    expect(decideWriteToolPermission('CreateFile', { content: '内容' }, makeProject('full')).kind).toBe('ask')
  })

  it('路径无法规范化时任何档位都 ask（防御性复核）', () => {
    expect(decideWriteToolPermission('EditFile', { path: '../逃逸.txt' }, makeProject('full')).kind).toBe('ask')
  })
})

describe('五档判定：仅审阅', () => {
  const project = makeProject('review')

  it('任何修改都 ask，包括章节正文', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第001章-开头.txt' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', { path: 'elements/characters/主角.md' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('CreateFile', { path: 'chapters/第002章-发展.txt' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('DeleteFile', { path: 'chapters/第001章-开头.txt' }, project).kind).toBe('ask')
  })
})

describe('五档判定：章节内容', () => {
  const project = makeProject('chapter')

  it('EditFile 改 chapters/ 已有章节正文免确认', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第003章-转折.txt' }, project)).toEqual({ kind: 'allow' })
  })

  it('改 elements/ 素材要确认；结构操作（含新章）要确认', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'elements/characters/主角.md' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('CreateFile', { path: 'chapters/第004章-新章.txt' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('DeleteFile', { path: 'chapters/第003章-转折.txt' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'chapters/第003章-转折.txt', toPath: 'chapters/第003章-改名.txt' }, project).kind).toBe('ask')
  })
})

describe('五档判定：素材内容', () => {
  const project = makeProject('material')

  it('改 elements/ 六个子目录免确认；改章节要确认', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'elements/worldbuilding/体系.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'elements/timeline/第一卷.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第003章-转折.txt' }, project).kind).toBe('ask')
  })
})

describe('五档判定：章节 + 素材（默认档）', () => {
  const project = makeProject('chapter-material')

  it('改章节与素材免确认', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'chapters/第003章-转折.txt' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'elements/entities/信物.md' }, project)).toEqual({ kind: 'allow' })
  })

  it('改 prompts/ 与 NovAI.md 弹卡（已知且接受的后果）', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'prompts/NovAI.md' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', { path: 'prompts/system.md' }, project).kind).toBe('ask')
  })

  it('CreateFile/DeleteFile/RenameFile 一律弹卡（结构操作）', () => {
    expect(decideWriteToolPermission('CreateFile', { path: 'chapters/第004章-新章.txt' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('DeleteFile', { path: 'elements/plots/旧线.md' }, project).kind).toBe('ask')
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'elements/plots/旧线.md', toPath: 'elements/plots/新线.md' }, project).kind).toBe('ask')
  })
})

describe('五档判定：完全访问', () => {
  const project = makeProject('full')

  it('内容修改与结构操作全部免确认', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'prompts/system.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('CreateFile', { path: 'prompts/scenes/新场景.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('DeleteFile', { path: 'chapters/第001章-开头.txt' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'a.md', toPath: 'b.md' }, project)).toEqual({ kind: 'allow' })
  })
})

describe('toApprovalOutcome', () => {
  it('授权永远一次性：accepted → allowed-once，拒绝 → rejected，无确认通道 → unavailable', () => {
    expect(toApprovalOutcome({ accepted: true })).toBe('allowed-once')
    expect(toApprovalOutcome({ accepted: false })).toBe('rejected')
    expect(toApprovalOutcome(null)).toBe('unavailable')
  })
})
