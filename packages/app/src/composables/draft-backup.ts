/**
 * 正文草稿的浏览器持久化备份（数据安全计划 §3-2）：
 * 内存草稿表（useFileDrafts）仍是运行期索引与权威状态；本模块把它镜像到
 * IndexedDB，浏览器刷新/异常退出后重新进入项目时可恢复未保存草稿。
 *
 * 固定规则：
 * - 写入去抖（800ms）；切换文件/项目、关闭面板与页面隐藏时调用 flush 立即落盘；
 * - 恢复不等于自动保存——恢复只回填内存草稿表，绝不改写正文文件；
 * - 保存成功（且仅本次保存绑定的草稿）或用户明确放弃时删除对应记录；
 * - 清理浏览器数据后无法恢复，磁盘正文始终是最终权威内容；
 * - 不在小说项目里建草稿目录，不生成逐文件草稿文件。
 */

const DATABASE_NAME = 'novai-drafts'
const DATABASE_VERSION = 1
const STORE_NAME = 'drafts'

/** 去抖窗口：编辑中的高频改动合并成一次 IndexedDB 写 */
const DRAFT_BACKUP_DEBOUNCE_MS = 800

export type PersistedDraftRecord = {
  /** 存储键（projectId 与 path 的无歧义编码） */
  key: string
  projectId: string
  path: string
  content: string
  /** 草稿所依据的磁盘内容快照（脏判定基线；恢复后据此提示磁盘是否已变化） */
  baseContent: string
  /** 草稿起源路径（重命名迁移前的旧路径；未迁移时缺省） */
  originPath?: string
  updatedAt: string
}

export function buildDraftKey(projectId: string, path: string): string {
  return JSON.stringify([projectId, path])
}

/** 存储后端抽象：生产为 IndexedDB；测试可注入内存实现 */
export interface DraftBackupStore {
  put(record: PersistedDraftRecord): Promise<void>
  delete(key: string): Promise<void>
  listByProject(projectId: string): Promise<PersistedDraftRecord[]>
}

function createIndexedDbStore(): DraftBackupStore {
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
      request.onerror = () => reject(request.error ?? new Error('打开草稿备份数据库失败'))
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
      request.onerror = () => reject(request.error ?? new Error('草稿备份存储操作失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('草稿备份事务失败'))
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
      const all = await runStoreRequest<PersistedDraftRecord[]>(
        database,
        'readonly',
        (store) => store.getAll() as IDBRequest<PersistedDraftRecord[]>,
      )
      database.close()
      return all.filter((record) => record.projectId === projectId)
    },
  }
}

/** 测试注入口：替换存储后端；传 null 恢复默认（IndexedDB 或不可用时的空实现） */
let store: DraftBackupStore = createStoreForEnvironment()

function createStoreForEnvironment(): DraftBackupStore {
  if (typeof indexedDB === 'undefined') {
    // 无 IndexedDB 的环境（SSR/测试）：备份退化为空操作，内存表照常工作
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

export function _setDraftBackupStoreForTest(replacement: DraftBackupStore | null): void {
  store = replacement ?? createStoreForEnvironment()
}

// ---------- 去抖写入 ----------

const pendingWrites = new Map<string, PersistedDraftRecord>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 记录一条草稿备份（去抖）；草稿表每次变更（set/move）调用 */
export function scheduleDraftBackup(
  projectId: string,
  path: string,
  entry: { content: string; baseContent: string; originPath?: string },
): void {
  const key = buildDraftKey(projectId, path)
  pendingWrites.set(key, {
    key,
    projectId,
    path,
    content: entry.content,
    baseContent: entry.baseContent,
    ...(entry.originPath !== undefined ? { originPath: entry.originPath } : {}),
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
      void writePending(key)
    }, DRAFT_BACKUP_DEBOUNCE_MS),
  )
}

async function writePending(key: string): Promise<void> {
  const record = pendingWrites.get(key)
  if (!record) {
    return
  }
  try {
    await store.put(record)
    pendingWrites.delete(key)
  } catch (error) {
    // 写入失败保留在 pending，由下一次调度或 flushDraftBackup 重试；
    // 备份失败不阻断编辑（内存表仍是本会话的权威状态）
    console.warn('[novai] 草稿备份写入失败，将在下次时机重试', error)
  }
}

/** 删除一条草稿备份（保存成功清除本次绑定的草稿、用户明确放弃时调用）——立即执行 */
export function removeDraftBackup(projectId: string, path: string): void {
  const key = buildDraftKey(projectId, path)
  const timer = debounceTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }
  pendingWrites.delete(key)
  void store.delete(key).catch((error) => {
    console.warn('[novai] 草稿备份删除失败', error)
  })
}

/** 立即落盘全部待写记录：切换文件/项目、关闭面板、页面隐藏时调用 */
export async function flushDraftBackup(): Promise<void> {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  const records = [...pendingWrites.values()]
  await Promise.all(
    records.map(async (record) => {
      try {
        await store.put(record)
        pendingWrites.delete(record.key)
      } catch (error) {
        console.warn('[novai] 草稿备份落盘失败，保留待重试', error)
      }
    }),
  )
}

/** 读取某项目的全部持久化草稿（先落盘待写记录，保证读到最新） */
export async function loadProjectDraftBackups(projectId: string): Promise<PersistedDraftRecord[]> {
  await flushDraftBackup()
  try {
    return await store.listByProject(projectId)
  } catch (error) {
    // 恢复失败必须让调用方可感知（内存内容保留，不静默置空）
    throw new Error(`读取草稿备份失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 生命周期挂接：页面隐藏/关闭前立即落盘。返回退订函数。 */
export function setupDraftBackupLifecycle(): () => void {
  const flush = () => {
    void flushDraftBackup()
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
export function _getPendingBackupKeysForTest(): string[] {
  return [...pendingWrites.keys()]
}

export function _resetDraftBackupForTest(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  pendingWrites.clear()
}
