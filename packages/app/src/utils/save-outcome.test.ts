import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _setDraftBackupStoreForTest,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from '../composables/draft-backup'
import {
  _clearFileDraftsForTest,
  clearFileDraft,
  getFileDraft,
  getFileDraftEntry,
  isFileDraftDirty,
  moveFileDraft,
  setFileDraft,
} from '../composables/useFileDrafts'
import { applyDraftAfterSave, resolveDraftAfterSave } from './save-outcome'

/**
 * 手动保存成功后的草稿去向（数据安全计划 §3-1，自动化验收 1/2/6 数据面）：
 * 保存绑定开始时的内容快照——成功后只清这份快照对应的草稿；保存期间继续
 * 输入的内容保留为未保存（基线换到落盘内容）。判定与应用是纯函数 + 草稿表，
 * FilePanelBody 成功回调只做透传，事件序在这里独立覆盖。
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

describe('resolveDraftAfterSave 判定', () => {
  it('无草稿或草稿==落盘内容：清除（保存成功清除本次绑定的草稿）', () => {
    expect(resolveDraftAfterSave(undefined, '落盘内容')).toEqual({ action: 'clear' })
    expect(resolveDraftAfterSave('落盘内容', '落盘内容')).toEqual({ action: 'clear' })
  })

  it('保存期间继续输入：rebase——新增输入保留，基线换到落盘内容', () => {
    expect(resolveDraftAfterSave('落盘内容+新输入', '落盘内容')).toEqual({
      action: 'rebase',
      content: '落盘内容+新输入',
      baseContent: '落盘内容',
    })
  })
})

describe('保存事件序（验收1/2：快照绑定与输入保留）', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(() => {
    _clearFileDraftsForTest()
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
  })

  it('验收2：保存甲期间继续输入——落盘旧快照，新输入保留为未保存且不被清除', () => {
    const projectId = 'proj-1'
    // t0：开始编辑甲，基线为磁盘内容 v0
    setFileDraft(projectId, 'chapters/甲.txt', 'v1', 'v0')
    // t1：保存启动，绑定快照 v1（此处模拟写盘在途）
    // t2：保存期间继续输入 → 草稿表已是 v2
    setFileDraft(projectId, 'chapters/甲.txt', 'v2', 'v0')
    // t3：v1 落盘成功，成功回调只处理本次保存绑定的内容
    applyDraftAfterSave(
      projectId,
      'chapters/甲.txt',
      resolveDraftAfterSave(getFileDraft(projectId, 'chapters/甲.txt'), 'v1'),
    )

    // 新输入保留为未保存，基线换到刚落盘的 v1
    expect(isFileDraftDirty(projectId, 'chapters/甲.txt')).toBe(true)
    expect(getFileDraft(projectId, 'chapters/甲.txt')).toBe('v2')
    expect(getFileDraftEntry(projectId, 'chapters/甲.txt')?.baseContent).toBe('v1')
  })

  it('验收1：甲的保存落盘只作用于甲——乙的草稿与内容不被修改', () => {
    const projectId = 'proj-1'
    setFileDraft(projectId, 'chapters/甲.txt', '甲草稿', '甲基线')
    setFileDraft(projectId, 'chapters/乙.txt', '乙草稿', '乙基线')

    // 保存甲期间切到乙继续编辑乙（乙草稿更新）
    setFileDraft(projectId, 'chapters/乙.txt', '乙草稿+继续输入', '乙基线')
    // 甲落盘成功且无新输入：只清甲
    applyDraftAfterSave(
      projectId,
      'chapters/甲.txt',
      resolveDraftAfterSave(getFileDraft(projectId, 'chapters/甲.txt'), '甲草稿'),
    )

    expect(isFileDraftDirty(projectId, 'chapters/甲.txt')).toBe(false)
    expect(getFileDraft(projectId, 'chapters/乙.txt')).toBe('乙草稿+继续输入')
    expect(getFileDraftEntry(projectId, 'chapters/乙.txt')?.baseContent).toBe('乙基线')
  })

  it('保存成功清除草稿时，持久化备份同步删除（不残留复活源）', () => {
    const projectId = 'proj-1'
    setFileDraft(projectId, 'chapters/甲.txt', 'v1', 'v0')
    applyDraftAfterSave(
      projectId,
      'chapters/甲.txt',
      resolveDraftAfterSave(getFileDraft(projectId, 'chapters/甲.txt'), 'v1'),
    )
    expect(store.records.size).toBe(0)
  })

  it('rebase 后的备份以新基线落盘：刷新恢复得到的草稿与磁盘版本关系正确', async () => {
    vi.useFakeTimers()
    try {
      const projectId = 'proj-1'
      setFileDraft(projectId, 'chapters/甲.txt', 'v1', 'v0')
      setFileDraft(projectId, 'chapters/甲.txt', 'v2', 'v0')
      applyDraftAfterSave(
        projectId,
        'chapters/甲.txt',
        resolveDraftAfterSave(getFileDraft(projectId, 'chapters/甲.txt'), 'v1'),
      )
      // 备份写入去抖 800ms：推进时钟让最后一次调度真正落盘
      await vi.advanceTimersByTimeAsync(800)

      const record = store.records.get(JSON.stringify([projectId, 'chapters/甲.txt']))
      expect(record?.content).toBe('v2')
      expect(record?.baseContent).toBe('v1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('删除/重命名后的草稿固定去向（验收5 数据面）', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    _setDraftBackupStoreForTest(createMemoryStore())
  })

  it('删除守护「放弃草稿」：草稿与备份一并清除，目标正文不受触碰', () => {
    const projectId = 'proj-1'
    setFileDraft(projectId, 'chapters/甲.txt', '未保存草稿', '磁盘基线')
    clearFileDraft(projectId, 'chapters/甲.txt')
    expect(isFileDraftDirty(projectId, 'chapters/甲.txt')).toBe(false)
  })

  it('重命名守护「迁移草稿」：内容与基线保留，旧路径关联进 originPath', () => {
    const projectId = 'proj-1'
    setFileDraft(projectId, 'chapters/旧名.txt', '未保存草稿', '磁盘基线')
    moveFileDraft(projectId, 'chapters/旧名.txt', 'chapters/新名.txt')

    expect(isFileDraftDirty(projectId, 'chapters/旧名.txt')).toBe(false)
    const entry = getFileDraftEntry(projectId, 'chapters/新名.txt')
    expect(entry?.content).toBe('未保存草稿')
    expect(entry?.baseContent).toBe('磁盘基线')
    expect(entry?.originPath).toBe('chapters/旧名.txt')
  })
})
