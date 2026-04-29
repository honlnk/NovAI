const DATABASE_NAME = 'novai-projects'
const DATABASE_VERSION = 1
const STORE_NAME = 'recent-projects'
const LAST_PROJECT_KEY = 'last-opened'

type PermissionMode = 'read' | 'readwrite'

type FileSystemPermissionDescriptor = {
  mode?: PermissionMode
}

type PersistableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemPermissionDescriptor) => Promise<PermissionState>
}

export type LastProjectRecord = {
  key: typeof LAST_PROJECT_KEY
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
  const record: LastProjectRecord = {
    key: LAST_PROJECT_KEY,
    projectId: input.projectId,
    name: input.name,
    rootName: input.rootName,
    lastOpenedAt: new Date().toISOString(),
    handle: input.handle,
  }

  const database = await openDatabase()

  await runStoreRequest(database, 'readwrite', (store) => store.put(record))
  database.close()

  return record
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

export async function forgetLastProject() {
  const database = await openDatabase()

  await runStoreRequest(database, 'readwrite', (store) => store.delete(LAST_PROJECT_KEY))
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
