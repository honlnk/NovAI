/// <reference types="vite/client" />

interface FileSystemDirectoryHandle {
  kind: 'directory'
  name: string
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  values(): AsyncIterableIterator<FileSystemHandle>
  keys(): AsyncIterableIterator<string>
}

interface FileSystemFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
}

interface FileSystemHandle {
  kind: 'file' | 'directory'
  name: string
  isSameEntry(other: FileSystemHandle): Promise<boolean>
  remove?(options?: { recursive?: boolean }): Promise<void>
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | BufferSource | Blob | { type: string; data?: unknown; position?: number; size?: number }): Promise<void>
  seek(position: number): Promise<void>
  truncate(size: number): Promise<void>
}

interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: FileSystemHandle | string }): Promise<FileSystemDirectoryHandle>
}
