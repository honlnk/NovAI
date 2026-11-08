import { describe, expect, it } from 'vitest'

import type { ProjectFileNodeView } from '@novai/core/services/types'
import { resolveActiveFileEffect, suggestCopyPath } from './file-tree'

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

describe('suggestCopyPath（草稿副本建议名）', () => {
  const tree: ProjectFileNodeView[] = [
    {
      kind: 'directory',
      path: 'chapters',
      name: 'chapters',
      children: [
        { kind: 'file', path: 'chapters/第001章-东宫听讼.txt', name: '第001章-东宫听讼.txt' },
        { kind: 'file', path: 'chapters/第001章-东宫听讼-草稿副本.txt', name: '第001章-东宫听讼-草稿副本.txt' },
        { kind: 'directory', path: 'chapters/第一卷', name: '第一卷', children: [
          { kind: 'file', path: 'chapters/第一卷/序章.md', name: '序章.md' },
        ] },
      ],
    },
  ]

  it('同目录下建议「<主干>-草稿副本<扩展名>」', () => {
    expect(suggestCopyPath(tree, 'chapters/序章.txt')).toBe('chapters/序章-草稿副本.txt')
  })

  it('无扩展名与根目录路径（无目录前缀）也能建议', () => {
    expect(suggestCopyPath([], 'README')).toBe('README-草稿副本')
    expect(suggestCopyPath(tree, 'chapters/第一卷/序章.md')).toBe('chapters/第一卷/序章-草稿副本.md')
  })

  it('建议名被占用时依次追加 -2/-3', () => {
    expect(suggestCopyPath(tree, 'chapters/第001章-东宫听讼.txt')).toBe('chapters/第001章-东宫听讼-草稿副本-2.txt')
  })

  it('占用判断递归覆盖嵌套子目录中的文件', () => {
    expect(suggestCopyPath(tree, 'chapters/第一卷/序章.md')).toBe('chapters/第一卷/序章-草稿副本.md')
    expect(suggestCopyPath([
      {
        kind: 'directory',
        path: 'chapters',
        name: 'chapters',
        children: [
          { kind: 'file', path: 'chapters/a-草稿副本.md', name: 'a-草稿副本.md' },
          { kind: 'file', path: 'chapters/a-草稿副本-2.md', name: 'a-草稿副本-2.md' },
        ],
      },
    ], 'chapters/a.md')).toBe('chapters/a-草稿副本-3.md')
  })
})
