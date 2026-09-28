import { describe, expect, it } from 'vitest'

import { resolveActiveFileEffect } from './file-tree'

describe('resolveActiveFileEffect（内容面板自动刷新判定）', () => {
  it('created / updated：命中当前打开路径返回 reload，不命中返回 null', () => {
    expect(resolveActiveFileEffect('chapters/第001章-初遇.txt', { type: 'created', path: 'chapters/第001章-初遇.txt' }))
      .toEqual({ action: 'reload', path: 'chapters/第001章-初遇.txt' })
    expect(resolveActiveFileEffect('chapters/第001章-初遇.txt', { type: 'updated', path: 'chapters/第001章-初遇.txt' }))
      .toEqual({ action: 'reload', path: 'chapters/第001章-初遇.txt' })
    expect(resolveActiveFileEffect('chapters/第001章-初遇.txt', { type: 'updated', path: 'elements/characters/主角.md' }))
      .toBeNull()
  })

  it('renamed：命中旧路径或新路径都 reload 到 toPath（旧路径已不存在）', () => {
    const renamed = { type: 'renamed' as const, fromPath: 'chapters/旧名.txt', toPath: 'chapters/新名.txt' }
    expect(resolveActiveFileEffect('chapters/旧名.txt', renamed)).toEqual({ action: 'reload', path: 'chapters/新名.txt' })
    expect(resolveActiveFileEffect('chapters/新名.txt', renamed)).toEqual({ action: 'reload', path: 'chapters/新名.txt' })
    expect(resolveActiveFileEffect('chapters/无关.txt', renamed)).toBeNull()
  })

  it('deleted：命中当前打开路径返回 clear（清空面板防幽灵文件），不命中返回 null', () => {
    expect(resolveActiveFileEffect('chapters/第001章-初遇.txt', { type: 'deleted', path: 'chapters/第001章-初遇.txt' }))
      .toEqual({ action: 'clear' })
    expect(resolveActiveFileEffect('chapters/第001章-初遇.txt', { type: 'deleted', path: 'elements/characters/主角.md' }))
      .toBeNull()
  })

  it('无打开文件时一律 null', () => {
    expect(resolveActiveFileEffect(null, { type: 'updated', path: 'a.md' })).toBeNull()
    expect(resolveActiveFileEffect(undefined, { type: 'deleted', path: 'a.md' })).toBeNull()
  })
})
