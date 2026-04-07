import type { IndexedElementDocument, ProjectIndexMeta } from '../../types/rag'

export type RagIndexStore = {
  getProjectMeta(projectId: string): Promise<ProjectIndexMeta | null>
  saveProjectMeta(meta: ProjectIndexMeta): Promise<void>
  listProjectDocuments(projectId: string): Promise<IndexedElementDocument[]>
  upsertDocuments(documents: IndexedElementDocument[]): Promise<void>
  removeDocuments(projectId: string, ids: string[]): Promise<void>
  clearProject(projectId: string): Promise<void>
}

const DB_NAME = 'novai-rag'
const DB_VERSION = 1
const ELEMENT_STORE = 'element_documents'
const META_STORE = 'index_meta'

type StoredElementDocument = IndexedElementDocument & {
  docKey: string
}

export function createRagIndexStore(): RagIndexStore {
  return {
    async getProjectMeta(projectId) {
      const db = await openDatabase()
      const record = await requestValue<ProjectIndexMeta | undefined>(
        db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(projectId),
      )
      return record ?? null
    },
    async saveProjectMeta(meta) {
      const db = await openDatabase()
      await requestValue(
        db.transaction(META_STORE, 'readwrite').objectStore(META_STORE).put(meta),
      )
    },
    async listProjectDocuments(projectId) {
      const db = await openDatabase()
      const records = await requestValue<StoredElementDocument[]>(
        db.transaction(ELEMENT_STORE, 'readonly').objectStore(ELEMENT_STORE).index('projectId').getAll(projectId),
      )

      return records.map(({ docKey: _docKey, ...document }) => document)
    },
    async upsertDocuments(documents) {
      if (documents.length === 0) {
        return
      }

      const db = await openDatabase()
      const store = db.transaction(ELEMENT_STORE, 'readwrite').objectStore(ELEMENT_STORE)

      for (const document of documents) {
        await requestValue(
          store.put({
            ...document,
            docKey: getDocumentKey(document.projectId, document.id),
          }),
        )
      }
    },
    async removeDocuments(projectId, ids) {
      if (ids.length === 0) {
        return
      }

      const db = await openDatabase()
      const store = db.transaction(ELEMENT_STORE, 'readwrite').objectStore(ELEMENT_STORE)

      for (const id of ids) {
        await requestValue(store.delete(getDocumentKey(projectId, id)))
      }
    },
    async clearProject(projectId) {
      const documents = await this.listProjectDocuments(projectId)
      await this.removeDocuments(projectId, documents.map((document) => document.id))
    },
  }
}

function getDocumentKey(projectId: string, id: string) {
  return `${projectId}::${id}`
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(ELEMENT_STORE)) {
        const elementStore = db.createObjectStore(ELEMENT_STORE, { keyPath: 'docKey' })
        elementStore.createIndex('projectId', 'projectId', { unique: false })
        elementStore.createIndex('sourcePath', 'sourcePath', { unique: false })
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'projectId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
  })
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}
