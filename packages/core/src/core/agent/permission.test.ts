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
    expect(decideWriteToolPermission('CreateFile', { path: 'prompts/outlines/新设定.md' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('DeleteFile', { path: 'chapters/第001章-开头.txt' }, project)).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'a.md', toPath: 'b.md' }, project)).toEqual({ kind: 'allow' })
  })
})

describe('技能仓库写入权限（3.6 锁定：skills/ 归提示词与配置类，不新增档位）', () => {
  it('EditFile 改 skills/ 下文件：章节、素材、章节与素材三档都弹卡', () => {
    const input = { path: 'skills/去AI味/SKILL.md', oldText: '旧', newText: '新' }
    expect(decideWriteToolPermission('EditFile', input, makeProject('chapter')).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', input, makeProject('material')).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', input, makeProject('chapter-material')).kind).toBe('ask')
  })

  it('EditFile 改 skills/ 下附属文件同样弹卡；「完全访问」免确认', () => {
    const input = { path: 'skills/去AI味/references/词表.md', oldText: '旧', newText: '新' }
    expect(decideWriteToolPermission('EditFile', input, makeProject('review')).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', input, makeProject('full'))).toEqual({ kind: 'allow' })
  })

  it('结构操作（新建/改名/删除技能文件）除「完全访问」外一律弹卡', () => {
    expect(decideWriteToolPermission('CreateFile', { path: 'skills/新技能/SKILL.md' }, makeProject('chapter-material')).kind).toBe('ask')
    expect(decideWriteToolPermission('CreateFile', { path: 'skills/新技能/SKILL.md' }, makeProject('full'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'skills/旧名/SKILL.md', toPath: 'skills/新名/SKILL.md' }, makeProject('full'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('RenameFile', { fromPath: 'skills/旧名/SKILL.md', toPath: 'skills/新名/SKILL.md' }, makeProject('chapter')).kind).toBe('ask')
    expect(decideWriteToolPermission('DeleteFile', { path: 'skills/去AI味/SKILL.md' }, makeProject('material')).kind).toBe('ask')
    expect(decideWriteToolPermission('DeleteFile', { path: 'skills/去AI味/SKILL.md' }, makeProject('full'))).toEqual({ kind: 'allow' })
  })

  it('弹卡理由指向提示词与配置类口径（沿用既有文案，不新增档位）', () => {
    const decision = decideWriteToolPermission(
      'EditFile',
      { path: 'skills/去AI味/SKILL.md', oldText: '旧', newText: '新' },
      makeProject('chapter-material'),
    )
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') {
      expect(decision.reason).toContain('提示词与配置类')
    }
  })
})

describe('创作心智专用工具（伏笔/节奏卡，以稳定标识定位无 path 字段）', () => {
  it('Update* 按素材档：material/chapter-material/full 放行，chapter/review 要确认', () => {
    const updateInput = { id: 'F-001', status: 'hinted' }
    expect(decideWriteToolPermission('UpdateForeshadowing', updateInput, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdateForeshadowing', updateInput, makeProject('chapter-material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdateForeshadowing', updateInput, makeProject('full'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdateForeshadowing', updateInput, makeProject('chapter')).kind).toBe('ask')
    expect(decideWriteToolPermission('UpdateForeshadowing', updateInput, makeProject('review')).kind).toBe('ask')

    expect(decideWriteToolPermission('RhythmUpdate', { id: 'R-001', actualConflict: 7 }, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('RhythmUpdate', { id: 'R-001', actualConflict: 7 }, makeProject('chapter')).kind).toBe('ask')
  })

  it('Create*/Delete* 走结构档：仅 full 放行，其余档位都要确认且提示语带领域名', () => {
    for (const tool of ['CreateForeshadowing', 'DeleteForeshadowing', 'RhythmCreate', 'RhythmDelete'] as const) {
      expect(decideWriteToolPermission(tool, { id: 'X-001' }, makeProject('full'))).toEqual({ kind: 'allow' })
      for (const preset of ['review', 'chapter', 'material', 'chapter-material'] as const) {
        const decision = decideWriteToolPermission(tool, { id: 'X-001' }, makeProject(preset))
        expect(decision.kind).toBe('ask')
        if (decision.kind === 'ask') {
          expect(decision.reason).toContain(tool.startsWith('Rhythm') ? '节奏卡' : '伏笔')
        }
      }
    }
  })

  it('通用文件工具写创作心智目录按素材档处理', () => {
    expect(decideWriteToolPermission('EditFile', { path: 'foreshadowing/F-001-信物.md' }, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'rhythm/R-001-第083章节奏.md' }, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', { path: 'rhythm/R-001-第083章节奏.md' }, makeProject('chapter')).kind).toBe('ask')
  })
})

describe('toApprovalOutcome', () => {
  it('授权永远一次性：accepted → allowed-once，拒绝 → rejected，无确认通道 → unavailable', () => {
    expect(toApprovalOutcome({ accepted: true })).toBe('allowed-once')
    expect(toApprovalOutcome({ accepted: false })).toBe('rejected')
    expect(toApprovalOutcome(null)).toBe('unavailable')
  })
})
