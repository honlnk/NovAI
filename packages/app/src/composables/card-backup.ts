/**
 * 看板卡片草稿的浏览器持久化备份（看板卡片详情自动保存与状态操作优化计划 §三）：
 * 与正文草稿备份（draft-backup）同一套机制——内存会话表是运行期权威状态，
 * 本模块把未落盘卡片草稿镜像到 IndexedDB，浏览器刷新/异常退出后重新进入
 * 项目时按卡片核对磁盘再决定回填/冲突/守护/清理。
 *
 * 固定规则：
 * - 写入去抖（800ms）；页面隐藏/关闭时 flush 立即落盘；
 * - 恢复不等于保存——恢复只回填统一保存会话，绝不直接改写卡片文件；
 * - 保存成功（且仅本次提交的快照）或用户明确放弃时删除对应记录；
 * - 记录携带草稿所依据的卡片版本令牌（contentHash）与编辑模式。
 */

import type { DetailMode } from '../components/layout/detail-mode'

const DATABASE_NAME = 'novai-card-drafts'
const DATABASE_VERSION = 1
const STORE_NAME = 'card-drafts'

/** 去抖窗口：卡片字段编辑的高频改动合并成一次 IndexedDB 写 */
const CARD_BACKUP_DEBOUNCE_MS = 800

/** 卡片字段草稿形状（计划卡/伏笔卡/节奏卡共用的最宽形状：字段值为标量或空） */
export type PersistedCardDraft = Record<string, string | number | null>

export type PersistedCardDraftRecord = {
  /** 存储键（projectId 与 cardId 的无歧义编码） */
  key: string
  projectId: string
  cardId: string
  draft: PersistedCardDraft
  /** 草稿所依据的磁盘卡片版本令牌（恢复核对的基线） */
  baseContentHash?: string
  mode: DetailMode
  /**
   * 待确认的放弃操作态（阶段 4，伏笔域）：原因与看板拖入的暂存落点。
   * 未确认绝不自动放弃；旧记录无此字段按无操作态恢复。
   */
  abandon?: { reason: string; afterId: string | null; beforeId: string | null }
  /**
   * 待确认的放弃原因修订操作态（作者字段控制权计划阶段 2，伏笔域）：
   * 已放弃卡的历史原因修订。未确认绝不自动写盘；旧记录无此字段按无操作态恢复。
   */
  reasonRevision?: { reason: string }
  /**
   * 待确认的作者校正操作态（作者字段控制权计划阶段 4，节奏域）：状态、偏差
   * 结论与说明的表单输入。未应用绝不自动写盘；旧记录无此字段按无操作态恢复。
   */
  authorCorrection?: { status: string; deviationFlag: boolean; deviationNote: string }
  /**
   * 待确认的恢复自动判定操作态（阶段 4，节奏域）：仅存在性即待确认，
   * 没有额外输入。未确认绝不自动写盘；旧记录无此字段按无操作态恢复。
   */
  restoreAutoPending?: true
  /**
   * 跨列拖拽的暂存落点（作者字段控制权计划阶段 5 §六，节奏域）：目标列与
   * 列内锚点。「应用校正」一次保存才落盘；未应用绝不移动。旧记录无此字段
   * 按无待确认落点恢复。
   */
  pendingPlacement?: { status: string; afterId: string | null; beforeId?: string | null }
  updatedAt: string
}

export function buildCardDraftKey(projectId: string, cardId: string): string {
  return JSON.stringify([projectId, cardId])
}

/** 存储后端抽象：生产为 IndexedDB；测试可注入内存实现 */
export interface CardBackupStore {
  put(record: PersistedCardDraftRecord): Promise<void>
  delete(key: string): Promise<void>
  listByProject(projectId: string): Promise<PersistedCardDraftRecord[]>
}

function createIndexedDbStore(): CardBackupStore {
  const openDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('打开卡片草稿备份数据库失败'))
    })

  const runStoreRequest = <T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      const request = action(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('卡片草稿备份存储操作失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('卡片草稿备份事务失败'))
    })

  return {
    async put(record) {
      const database = await openDatabase()
      await runStoreRequest(database, 'readwrite', (store) => store.put(record))
      database.close()
    },
    async delete(key) {
      const database = await openDatabase()
      await runStoreRequest(database, 'readwrite', (store) => store.delete(key))
      database.close()
    },
    async listByProject(projectId) {
      const database = await openDatabase()
      const all = await runStoreRequest<PersistedCardDraftRecord[]>(
        database,
        'readonly',
        (store) => store.getAll() as IDBRequest<PersistedCardDraftRecord[]>,
      )
      database.close()
      return all.filter((record) => record.projectId === projectId)
    },
  }
}

/** 测试注入口：替换存储后端；传 null 恢复默认（IndexedDB 或不可用时的空实现） */
let store: CardBackupStore = createStoreForEnvironment()

function createStoreForEnvironment(): CardBackupStore {
  if (typeof indexedDB === 'undefined') {
    // 无 IndexedDB 的环境（SSR/测试）：备份退化为空操作，会话表照常工作
    return {
      async put() {},
      async delete() {},
      async listByProject() {
        return []
      },
    }
  }
  return createIndexedDbStore()
}

export function _setCardBackupStoreForTest(replacement: CardBackupStore | null): void {
  store = replacement ?? createStoreForEnvironment()
}

// ---------- 去抖写入 ----------

const pendingWrites = new Map<string, PersistedCardDraftRecord>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 同一卡片键的写入、删除与 flush 串行，避免旧写晚到覆盖新草稿或复活已清除记录。 */
const backupOperations = new Map<string, Promise<void>>()

function enqueueBackupOperation(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = backupOperations.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(operation)
  backupOperations.set(key, run)
  const cleanup = () => {
    if (backupOperations.get(key) === run) {
      backupOperations.delete(key)
    }
  }
  void run.then(cleanup, cleanup)
  return run
}

async function writeLatestPending(key: string): Promise<void> {
  const record = pendingWrites.get(key)
  if (!record) {
    return
  }
  try {
    await store.put(record)
    // 写入期间又产生了新草稿：只确认本次快照，不得吞掉较新的待写记录。
    if (pendingWrites.get(key) === record) {
      pendingWrites.delete(key)
    }
  } catch (error) {
    // 写入失败保留在 pending，由下一次调度或 flushCardBackup 重试。
    console.warn('[novai] 卡片草稿备份写入失败，将在下次时机重试', error)
  }
}

/**
 * 记录一条卡片草稿备份（去抖）；会话每次输入、模式切换调用。快照外的待确认
 * 操作态（放弃/原因修订/作者校正/恢复自动/跨列落点）一并入镜像——刷新后按
 * 待确认状态恢复，绝不自动执行。
 */
export function scheduleCardBackup(
  projectId: string,
  cardId: string,
  entry: {
    draft: PersistedCardDraft
    baseContentHash?: string
    mode: DetailMode
    abandon?: PersistedCardDraftRecord['abandon']
    reasonRevision?: PersistedCardDraftRecord['reasonRevision']
    authorCorrection?: PersistedCardDraftRecord['authorCorrection']
    restoreAutoPending?: PersistedCardDraftRecord['restoreAutoPending']
    pendingPlacement?: PersistedCardDraftRecord['pendingPlacement']
  },
): void {
  const key = buildCardDraftKey(projectId, cardId)
  pendingWrites.set(key, {
    key,
    projectId,
    cardId,
    draft: { ...entry.draft },
    ...(entry.baseContentHash !== undefined ? { baseContentHash: entry.baseContentHash } : {}),
    mode: entry.mode,
    ...(entry.abandon !== undefined ? { abandon: { ...entry.abandon } } : {}),
    ...(entry.reasonRevision !== undefined ? { reasonRevision: { ...entry.reasonRevision } } : {}),
    ...(entry.authorCorrection !== undefined ? { authorCorrection: { ...entry.authorCorrection } } : {}),
    ...(entry.restoreAutoPending !== undefined ? { restoreAutoPending: true } : {}),
    ...(entry.pendingPlacement !== undefined ? { pendingPlacement: { ...entry.pendingPlacement } } : {}),
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
      void enqueueBackupOperation(key, () => writeLatestPending(key))
    }, CARD_BACKUP_DEBOUNCE_MS),
  )
}

/** 删除一条卡片草稿备份（保存成功清除本次提交的草稿、明确放弃时调用）——立即执行 */
export function removeCardBackup(projectId: string, cardId: string): void {
  const key = buildCardDraftKey(projectId, cardId)
  const timer = debounceTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }
  pendingWrites.delete(key)
  void enqueueBackupOperation(key, async () => {
    try {
      await store.delete(key)
    } catch (error) {
      console.warn('[novai] 卡片草稿备份删除失败', error)
    }
  })
}

/** 立即落盘全部待写记录：切换卡片/项目、页面隐藏时调用 */
export async function flushCardBackup(): Promise<void> {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  const records = [...pendingWrites.values()]
  await Promise.all(
    records.map((record) => enqueueBackupOperation(record.key, () => writeLatestPending(record.key))),
  )
}

/** 读取某项目的全部持久化卡片草稿（先落盘待写记录，保证读到最新） */
export async function loadProjectCardBackups(projectId: string): Promise<PersistedCardDraftRecord[]> {
  await flushCardBackup()
  try {
    return await store.listByProject(projectId)
  } catch (error) {
    // 恢复失败必须让调用方可感知（内存内容保留，不静默置空）
    throw new Error(`读取卡片草稿备份失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 生命周期挂接：页面隐藏/关闭前立即落盘。返回退订函数。 */
export function setupCardBackupLifecycle(): () => void {
  const flush = () => {
    void flushCardBackup()
  }
  document.addEventListener('visibilitychange', flush)
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  return () => {
    document.removeEventListener('visibilitychange', flush)
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', flush)
  }
}

/** 测试注入口：读取待写记录（验证去抖/flush 语义） */
export function _getPendingCardBackupKeysForTest(): string[] {
  return [...pendingWrites.keys()]
}

export function _resetCardBackupForTest(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  pendingWrites.clear()
  backupOperations.clear()
}
