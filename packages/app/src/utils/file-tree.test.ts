import { describe, expect, it } from 'vitest'

import { resolveActiveFileReloadTarget } from './file-tree'

describe('resolveActiveFileReloadTarget（内容面板自动重读判定）', () => {
  it('created / updated：命中当前打开路径返回该路径，不命中返回 null', () => {
    expect(resolveActiveFileReloadTarget('chapters/第001章-初遇.txt', { type: 'created', path: 'chapters/第001章-初遇.txt' }))
      .toBe('chapters/第001章-初遇.txt')
    expect(resolveActiveFileReloadTarget('chapters/第001章-初遇.txt', { type: 'updated', path: 'chapters/第001章-初遇.txt' }))
      .toBe('chapters/第001章-初遇.txt')
    expect(resolveActiveFileReloadTarget('chapters/第001章-初遇.txt', { type: 'updated', path: 'elements/characters/主角.md' }))
      .toBeNull()
  })

  it('renamed：命中旧路径或新路径都返回 toPath（旧路径已不存在，重读要落到新路径）', () => {
    const renamed = { type: 'renamed' as const, fromPath: 'chapters/旧名.txt', toPath: 'chapters/新名.txt' }
    expect(resolveActiveFileReloadTarget('chapters/旧名.txt', renamed)).toBe('chapters/新名.txt')
    expect(resolveActiveFileReloadTarget('chapters/新名.txt', renamed)).toBe('chapters/新名.txt')
    expect(resolveActiveFileReloadTarget('chapters/无关.txt', renamed)).toBeNull()
  })

  it('deleted：一律不重读（重读必失败；树刷新后列表项已消失，面板保留最后内容等用户切走）', () => {
    expect(resolveActiveFileReloadTarget('chapters/第001章-初遇.txt', { type: 'deleted', path: 'chapters/第001章-初遇.txt' }))
      .toBeNull()
  })

  it('无打开文件时一律 null', () => {
    expect(resolveActiveFileReloadTarget(null, { type: 'updated', path: 'a.md' })).toBeNull()
    expect(resolveActiveFileReloadTarget(undefined, { type: 'updated', path: 'a.md' })).toBeNull()
  })
})
