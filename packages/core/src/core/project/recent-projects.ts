const DATABASE_NAME = 'novai-projects'
const DATABASE_VERSION = 2
const STORE_NAME = 'recent-projects'
const LAST_PROJECT_KEY = 'last-opened'
const MAX_RECENT_PROJECTS = 8

type PermissionMode = 'read' | 'readwrite'

type FileSystemPermissionDescriptor = {
  mode?: PermissionMode
}

type PersistableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
}

export type LastProjectRecord = {
  key: typeof LAST_PROJECT_KEY | `project-${string}`
  projectId: string
  name: string
  rootName: string
  lastOpenedAt: string
  handle: FileSystemDirectoryHandle
}

export type LastProjectSummary = Omit<LastProjectRecord, 'handle' | 'key'>

export async function saveLastProject(input: {
  projectId: string
  name: string
  rootName: string
  handle: FileSystemDirectoryHandle
}): Promise<LastProjectRecord> {
  const database = await openDatabase()
  const now = new Date().toISOString()

  // 保存为最后一个项目
  const lastRecord: LastProjectRecord = {
    key: LAST_PROJECT_KEY,
    projectId: input.projectId,
    name: input.name,
    rootName: input.rootName,
    lastOpenedAt: now,
    handle: input.handle,
  }

  // 保存到最近项目列表
  const recentRecord: LastProjectRecord = {
    key: `project-${input.projectId}`,
    projectId: input.projectId,
    name: input.name,
    rootName: input.rootName,
    lastOpenedAt: now,
    handle: input.handle,
  }

  await runStoreRequest(database, 'readwrite', (store) => store.put(lastRecord))
  await runStoreRequest(database, 'readwrite', (store) => store.put(recentRecord))

  // 清理超过限制的旧记录
  await cleanupOldProjects(database)

  database.close()

  return lastRecord
}

export async function readLastProject(): Promise<LastProjectRecord | null> {
  const database = await openDatabase()
  const record = await runStoreRequest<LastProjectRecord | undefined>(
    database,
    'readonly',
    (store) => store.get(LAST_PROJECT_KEY),
  )

  database.close()
  return record ?? null
}

export async function readRecentProjects(): Promise<LastProjectSummary[]> {
  const database = await openDatabase()
  const allRecords = await runStoreRequest<LastProjectRecord[]>(
    database,
    'readonly',
    (store) => store.getAll(),
  )

  database.close()

  // 过滤出最近项目记录（排除 last-opened），按时间倒序
  const recentRecords = allRecords
    .filter((record) => record.key !== LAST_PROJECT_KEY)
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime())
    .slice(0, MAX_RECENT_PROJECTS)

  return recentRecords.map((record) => ({
    projectId: record.projectId,
    name: record.name,
    rootName: record.rootName,
    lastOpenedAt: record.lastOpenedAt,
  }))
}

export async function forgetLastProject() {
  const database = await openDatabase()

  await runStoreRequest(database, 'readwrite', (store) => store.delete(LAST_PROJECT_KEY))
  database.close()
}

export async function forgetRecentProject(projectId: string) {
  const database = await openDatabase()

  await runStoreRequest(database, 'readwrite', (store) => store.delete(`project-${projectId}`))
  database.close()
}

export async function hasProjectPermission(handle: FileSystemDirectoryHandle) {
  const target = handle as PersistableDirectoryHandle

  if (!target.queryPermission) {
    return false
  }

  return (await target.queryPermission({ mode: 'readwrite' })) === 'granted'
}

export async function requestProjectPermission(handle: FileSystemDirectoryHandle) {
  const target = handle as PersistableDirectoryHandle

  if (await hasProjectPermission(handle)) {
    return true
  }

  if (!target.requestPermission) {
    return false
  }

  return (await target.requestPermission({ mode: 'readwrite' })) === 'granted'
}

export function toLastProjectSummary(record: LastProjectRecord): LastProjectSummary {
  return {
    projectId: record.projectId,
    name: record.name,
    rootName: record.rootName,
    lastOpenedAt: record.lastOpenedAt,
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开最近项目数据库失败'))
  })
}

async function cleanupOldProjects(database: IDBDatabase): Promise<void> {
  const allRecords = await runStoreRequest<LastProjectRecord[]>(
    database,
    'readonly',
    (store) => store.getAll(),
  )

  // 过滤出最近项目记录
  const recentRecords = allRecords
    .filter((record) => record.key !== LAST_PROJECT_KEY)
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime())

  // 删除超过限制的旧记录
  if (recentRecords.length > MAX_RECENT_PROJECTS) {
    const recordsToDelete = recentRecords.slice(MAX_RECENT_PROJECTS)
    for (const record of recordsToDelete) {
      await runStoreRequest(database, 'readwrite', (store) => store.delete(record.key))
    }
  }
}

function runStoreRequest<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    const request = action(store)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('最近项目存储操作失败'))
    transaction.onerror = () => reject(transaction.error ?? new Error('最近项目事务失败'))
  })
}
