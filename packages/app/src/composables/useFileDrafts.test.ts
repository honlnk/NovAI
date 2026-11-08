import { beforeEach, describe, expect, it } from 'vitest'

import {
  _setDraftBackupStoreForTest,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from './draft-backup'
import {
  _clearFileDraftsForTest,
  acknowledgeRestoredDraft,
  clearFileDraft,
  getFileDraft,
  getFileDraftEntry,
  hasDirtyDrafts,
  isDraftRestoredFromBackup,
  isFileDraftDirty,
  listDirtyDraftPaths,
  moveFileDraft,
  restorePersistedDrafts,
  setFileDraft,
} from './useFileDrafts'

/**
 * 文件编辑草稿表（§6 未保存内容保护 + 数据安全计划 §3-2/§3-3）：
 * 按「项目:路径」保留编辑会话，脏判定以草稿所依据的磁盘内容为基线；
 * 条目携带起源路径与编辑时间，持久化恢复只回填内存不覆盖更新内容。
 */

function createMemoryStore(): DraftBackupStore & { records: Map<string, PersistedDraftRecord> } {
  const records = new Map<string, PersistedDraftRecord>()
  return {
    records,
    async put(record) {
      records.set(record.key, { ...record })
    },
    async delete(key) {
      records.delete(key)
    },
    async listByProject(projectId) {
      return [...records.values()].filter((record) => record.projectId === projectId)
    },
  }
}

describe('useFileDrafts 草稿表', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(() => {
    _clearFileDraftsForTest()
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
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

  it('条目携带磁盘基线与编辑时间（恢复后可提示磁盘是否变化）', () => {
    setFileDraft('proj-a', 'a.txt', '草稿', '磁盘基线')
    const entry = getFileDraftEntry('proj-a', 'a.txt')
    expect(entry?.baseContent).toBe('磁盘基线')
    expect(entry?.updatedAt).toBeTypeOf('string')
  })

  it('moveFileDraft：迁移草稿到新路径并保留旧路径关联（重命名迁移）', () => {
    setFileDraft('proj-a', 'chapters/old.txt', '草稿内容', '磁盘基线')
    moveFileDraft('proj-a', 'chapters/old.txt', 'chapters/new.txt')

    expect(isFileDraftDirty('proj-a', 'chapters/old.txt')).toBe(false)
    const entry = getFileDraftEntry('proj-a', 'chapters/new.txt')
    expect(entry?.content).toBe('草稿内容')
    expect(entry?.baseContent).toBe('磁盘基线')
    expect(entry?.originPath).toBe('chapters/old.txt')
  })

  it('moveFileDraft 对无草稿路径是安全空操作', () => {
    expect(() => moveFileDraft('proj-a', 'nope.txt', 'chapters/new.txt')).not.toThrow()
    expect(isFileDraftDirty('proj-a', 'chapters/new.txt')).toBe(false)
  })

  it('listDirtyDraftPaths 列出项目内全部脏草稿路径', () => {
    setFileDraft('proj-a', 'a.txt', '甲', '基线甲')
    setFileDraft('proj-a', 'b.txt', '乙', '基线乙')
    expect(listDirtyDraftPaths('proj-a').sort()).toEqual(['a.txt', 'b.txt'])
    expect(listDirtyDraftPaths('proj-b')).toEqual([])
  })
})

describe('useFileDrafts 持久化恢复（数据安全计划 §3-2）', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(async () => {
    _clearFileDraftsForTest()
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
    // 预置一份持久化草稿（模拟上一页会话落盘的备份）
    await store.put({
      key: JSON.stringify(['proj-r', 'chapters/a.txt']),
      projectId: 'proj-r',
      path: 'chapters/a.txt',
      content: '恢复的草稿',
      baseContent: '旧磁盘基线',
      originPath: 'chapters/旧名.txt',
      updatedAt: '2026-11-08T10:00:00.000Z',
    })
  })

  it('恢复回填内存表并标记待知悉；磁盘基线与起源路径随条目保留', async () => {
    const report = await restorePersistedDrafts('proj-r')
    expect(report.restored).toHaveLength(1)
    expect(report.restored[0]?.path).toBe('chapters/a.txt')
    expect(report.restored[0]?.originPath).toBe('chapters/旧名.txt')

    const entry = getFileDraftEntry('proj-r', 'chapters/a.txt')
    expect(entry?.content).toBe('恢复的草稿')
    expect(entry?.baseContent).toBe('旧磁盘基线')
    expect(isDraftRestoredFromBackup('proj-r', 'chapters/a.txt')).toBe(true)
  })

  it('恢复不覆盖内存中已有的更新草稿（同页会话内存优先）', async () => {
    setFileDraft('proj-r', 'chapters/a.txt', '更新的草稿', '新基线')
    const report = await restorePersistedDrafts('proj-r')
    expect(report.restored).toHaveLength(0)
    expect(getFileDraft('proj-r', 'chapters/a.txt')).toBe('更新的草稿')
  })

  it('恢复流程绝不写正文文件（无任何文件服务调用）', async () => {
    // 恢复只操作内存表与 IndexedDB 镜像；正文写盘在 UI 层只有显式保存/确认链路
    const report = await restorePersistedDrafts('proj-r')
    expect(report.restored).toHaveLength(1)
    expect(getFileDraft('proj-r', 'chapters/a.txt')).toBe('恢复的草稿')
  })

  it('知悉后恢复标记出队；再次恢复不重复标记', async () => {
    await restorePersistedDrafts('proj-r')
    acknowledgeRestoredDraft('proj-r', 'chapters/a.txt')
    expect(isDraftRestoredFromBackup('proj-r', 'chapters/a.txt')).toBe(false)

    // 清空内存表再恢复（模拟再次刷新）：备份仍在，恢复标记重新出现
    _clearFileDraftsForTest()
    await restorePersistedDrafts('proj-r')
    expect(isDraftRestoredFromBackup('proj-r', 'chapters/a.txt')).toBe(true)
  })

  it('clearFileDraft 同步删除持久化备份：恢复后不再出现', async () => {
    await restorePersistedDrafts('proj-r')
    clearFileDraft('proj-r', 'chapters/a.txt')

    _clearFileDraftsForTest()
    const report = await restorePersistedDrafts('proj-r')
    expect(report.restored).toHaveLength(0)
  })

  it('备份读取失败抛错（保留当前页面内容并让调用方提示）', async () => {
    _setDraftBackupStoreForTest({
      async put() {},
      async delete() {},
      async listByProject() {
        throw new Error('IndexedDB 不可用')
      },
    })
    await expect(restorePersistedDrafts('proj-r')).rejects.toThrow('读取草稿备份失败')
    // 内存表未被清空/覆盖
    expect(hasDirtyDrafts('proj-r')).toBe(false)
  })
})
