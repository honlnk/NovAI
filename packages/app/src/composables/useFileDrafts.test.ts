import { beforeEach, describe, expect, it } from 'vitest'

import {
  _clearFileDraftsForTest,
  clearFileDraft,
  getFileDraft,
  hasDirtyDrafts,
  isFileDraftDirty,
  setFileDraft,
} from './useFileDrafts'

/**
 * 文件编辑草稿表（§6 未保存内容保护）：按「项目:路径」保留编辑会话，
 * 脏判定以草稿所依据的磁盘内容为基线。
 */
describe('useFileDrafts 草稿表', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
  })

  it('记录与取回：同路径往返一致，项目间隔离', () => {
    setFileDraft('proj-a', 'chapters/第001章-东宫听讼.txt', '草稿内容', '磁盘内容')
    expect(getFileDraft('proj-a', 'chapters/第001章-东宫听讼.txt')).toBe('草稿内容')
    expect(getFileDraft('proj-b', 'chapters/第001章-东宫听讼.txt')).toBeUndefined()
  })

  it('草稿与磁盘一致时自动清除（不残留假脏条目）', () => {
    setFileDraft('proj-a', 'a.txt', '改过的内容', '磁盘内容')
    expect(isFileDraftDirty('proj-a', 'a.txt')).toBe(true)
    setFileDraft('proj-a', 'a.txt', '磁盘内容', '磁盘内容')
    expect(isFileDraftDirty('proj-a', 'a.txt')).toBe(false)
    expect(getFileDraft('proj-a', 'a.txt')).toBeUndefined()
  })

  it('hasDirtyDrafts 按项目判定，清除后回落', () => {
    expect(hasDirtyDrafts('proj-a')).toBe(false)
    setFileDraft('proj-a', 'a.txt', '草稿', '磁盘')
    expect(hasDirtyDrafts('proj-a')).toBe(true)
    expect(hasDirtyDrafts('proj-b')).toBe(false)
    clearFileDraft('proj-a', 'a.txt')
    expect(hasDirtyDrafts('proj-a')).toBe(false)
  })

  it('clear 未存在的路径是安全空操作', () => {
    expect(() => clearFileDraft('proj-x', 'nope.txt')).not.toThrow()
  })
})
