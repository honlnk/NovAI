/**
 * 关系详情草稿的浏览器持久化备份（关系图谱施工计划 §六：详情编辑接入 save-session）：
 * 与卡片草稿备份（card-backup）同一套机制——内存会话表是运行期权威状态，本模块
 * 把未落盘的关系详情草稿镜像到 localStorage（关系草稿只有四个短字段，无需 IndexedDB），
 * 浏览器刷新后重新进入项目时按关系核对磁盘再决定回填/冲突/清理。
 *
 * 固定规则（与 card-backup 一致）：
 * - 写入去抖；恢复不等于保存——只回填保存会话，绝不直接改写关系账本；
 * - 保存成功或明确放弃时删除对应记录；记录携带草稿依据的账本内容哈希。
 */

const STORAGE_PREFIX = 'novai-relation-draft:'

/** 去抖窗口：关系字段编辑的高频改动合并成一次写入 */
const RELATION_BACKUP_DEBOUNCE_MS = 800

/** 关系详情草稿（编辑中的字段集；端点以稳定标识承载） */
export type RelationDraft = {
  type: string
  description: string
  fromId: string
  toId: string
}

export type PersistedRelationDraftRecord = {
  projectId: string
  relationId: string
  draft: RelationDraft
  /** 草稿依据的账本内容哈希（恢复核对的基线；账本不存在时为空串） */
  baseContentHash: string
  updatedAt: string
}

export function buildRelationDraftKey(projectId: string, relationId: string): string {
  return `${STORAGE_PREFIX}${JSON.stringify([projectId, relationId])}`
}

/** 存储后端抽象：生产为 localStorage；测试可注入内存实现 */
export interface RelationBackupStore {
  put(key: string, record: PersistedRelationDraftRecord): void
  delete(key: string): void
  listByProject(projectId: string): PersistedRelationDraftRecord[]
}

function createLocalStorageStore(): RelationBackupStore {
  return {
    put(key, record) {
      try {
        localStorage.setItem(key, JSON.stringify(record))
      } catch (error) {
        console.warn('[novai] 关系草稿备份写入失败', error)
      }
    },
    delete(key) {
      try {
        localStorage.removeItem(key)
      } catch (error) {
        console.warn('[novai] 关系草稿备份删除失败', error)
      }
    },
    listByProject(projectId) {
      const records: PersistedRelationDraftRecord[] = []
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (!key || !key.startsWith(STORAGE_PREFIX)) {
            continue
          }
          const raw = localStorage.getItem(key)
          if (!raw) {
            continue
          }
          try {
            const record = JSON.parse(raw) as PersistedRelationDraftRecord
            if (record.projectId === projectId) {
              records.push(record)
            }
          } catch {
            // 单条损坏记录跳过，不阻塞其余恢复
          }
        }
      } catch (error) {
        console.warn('[novai] 关系草稿备份读取失败', error)
      }
      return records
    },
  }
}

/** 测试注入口：替换存储后端；传 null 恢复默认 */
let store: RelationBackupStore = createStoreForEnvironment()

function createStoreForEnvironment(): RelationBackupStore {
  if (typeof localStorage === 'undefined') {
    return {
      put() {},
      delete() {},
      listByProject() {
        return []
      },
    }
  }
  return createLocalStorageStore()
}

export function _setRelationBackupStoreForTest(replacement: RelationBackupStore | null): void {
  store = replacement ?? createStoreForEnvironment()
}

// ---------- 去抖写入 ----------

const pendingWrites = new Map<string, PersistedRelationDraftRecord>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleRelationBackup(
  projectId: string,
  relationId: string,
  entry: { draft: RelationDraft; baseContentHash: string },
): void {
  const key = buildRelationDraftKey(projectId, relationId)
  pendingWrites.set(key, {
    projectId,
    relationId,
    draft: { ...entry.draft },
    baseContentHash: entry.baseContentHash,
    updatedAt: new Date().toISOString(),
  })
  const existing = debounceTimers.get(key)
  if (existing) {
    clearTimeout(existing)
  }
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key)
      const record = pendingWrites.get(key)
      if (record) {
        pendingWrites.delete(key)
        store.put(key, record)
      }
    }, RELATION_BACKUP_DEBOUNCE_MS),
  )
}

export function removeRelationBackup(projectId: string, relationId: string): void {
  const key = buildRelationDraftKey(projectId, relationId)
  const timer = debounceTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }
  pendingWrites.delete(key)
  store.delete(key)
}

/** 读取某项目的全部持久化关系草稿（先落盘待写记录） */
export function loadProjectRelationBackups(projectId: string): PersistedRelationDraftRecord[] {
  for (const [key, record] of [...pendingWrites.entries()]) {
    if (record.projectId === projectId) {
      pendingWrites.delete(key)
      store.put(key, record)
    }
  }
  return store.listByProject(projectId)
}

/** 测试注入口：清空全部待写记录 */
export function _resetRelationBackupForTest(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  pendingWrites.clear()
}
