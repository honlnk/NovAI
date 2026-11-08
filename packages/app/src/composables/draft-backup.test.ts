import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _getPendingBackupKeysForTest,
  _resetDraftBackupForTest,
  _setDraftBackupStoreForTest,
  buildDraftKey,
  flushDraftBackup,
  loadProjectDraftBackups,
  removeDraftBackup,
  scheduleDraftBackup,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from './draft-backup'

/**
 * 草稿备份（IndexedDB 镜像）的去抖/落盘/删除语义（数据安全计划 §3-2）。
 * 用内存 store 注入，避免测试环境依赖真实 IndexedDB；去抖用假时钟控制。
 */

function createMemoryStore(): DraftBackupStore & {
  records: Map<string, PersistedDraftRecord>
  failNextPut: boolean
} {
  const records = new Map<string, PersistedDraftRecord>()
  return {
    records,
    failNextPut: false,
    async put(record) {
      if (this.failNextPut) {
        this.failNextPut = false
        throw new Error('模拟 IndexedDB 写失败')
      }
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

describe('draft-backup 草稿备份', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(() => {
    vi.useFakeTimers()
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
    _resetDraftBackupForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    _setDraftBackupStoreForTest(null)
  })

  it('去抖窗口内合并写入：未到窗口不落盘，到期落一条最新内容', async () => {
    scheduleDraftBackup('p1', 'chapters/a.txt', { content: '第一版', baseContent: '原稿' })
    scheduleDraftBackup('p1', 'chapters/a.txt', { content: '第二版', baseContent: '原稿' })
    expect(store.records.size).toBe(0)
    expect(_getPendingBackupKeysForTest()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(800)
    expect(store.records.size).toBe(1)
    const record = store.records.get(buildDraftKey('p1', 'chapters/a.txt'))
    expect(record?.content).toBe('第二版')
    expect(_getPendingBackupKeysForTest()).toHaveLength(0)
  })

  it('flushDraftBackup 立即落盘全部待写记录（切换文件/项目、页面隐藏时机）', async () => {
    scheduleDraftBackup('p1', 'a.txt', { content: '甲草稿', baseContent: '甲' })
    scheduleDraftBackup('p1', 'b.txt', { content: '乙草稿', baseContent: '乙' })
    scheduleDraftBackup('p2', 'c.txt', { content: '丙草稿', baseContent: '丙' })

    await flushDraftBackup()
    expect(store.records.size).toBe(3)
    expect(_getPendingBackupKeysForTest()).toHaveLength(0)
  })

  it('removeDraftBackup 取消待写并删除既有记录（保存成功/放弃草稿）', async () => {
    scheduleDraftBackup('p1', 'a.txt', { content: '草稿', baseContent: '原' })
    await flushDraftBackup()
    expect(store.records.size).toBe(1)

    scheduleDraftBackup('p1', 'a.txt', { content: '再次修改', baseContent: '原' })
    removeDraftBackup('p1', 'a.txt')

    // 待写取消：推进去抖窗口后没有新增记录
    await vi.advanceTimersByTimeAsync(800)
    expect(store.records.size).toBe(0)
  })

  it('loadProjectDraftBackups 先落盘待写再按项目过滤', async () => {
    scheduleDraftBackup('p1', 'a.txt', { content: '甲', baseContent: '' })
    scheduleDraftBackup('p2', 'b.txt', { content: '乙', baseContent: '' })

    const p1Records = await loadProjectDraftBackups('p1')
    expect(p1Records.map((record) => record.path)).toEqual(['a.txt'])
    expect(store.records.size).toBe(2)
  })

  it('单条写失败保留待重试，不阻断其他记录落盘', async () => {
    scheduleDraftBackup('p1', 'a.txt', { content: '甲', baseContent: '' })
    scheduleDraftBackup('p1', 'b.txt', { content: '乙', baseContent: '' })
    store.failNextPut = true

    await flushDraftBackup()
    // b.txt 成功；a.txt 失败留在 pending
    expect(store.records.get(buildDraftKey('p1', 'b.txt'))?.content).toBe('乙')
    expect(_getPendingBackupKeysForTest()).toEqual([buildDraftKey('p1', 'a.txt')])

    // 下一次 flush 重试成功
    await flushDraftBackup()
    expect(store.records.get(buildDraftKey('p1', 'a.txt'))?.content).toBe('甲')
  })

  it('loadProjectDraftBackups 读失败抛错（调用方可感知，不静默置空）', async () => {
    _setDraftBackupStoreForTest({
      async put() {},
      async delete() {},
      async listByProject() {
        throw new Error('IndexedDB 不可用')
      },
    })
    await expect(loadProjectDraftBackups('p1')).rejects.toThrow('读取草稿备份失败')
  })
})
