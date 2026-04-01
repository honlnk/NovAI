/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface FilePickerOptions {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

interface FileSystemWritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory'
  values(): AsyncIterable<FileSystemHandle>
  getFileHandle(
    name: string,
    options?: {
      create?: boolean
    },
  ): Promise<FileSystemFileHandle>
  getDirectoryHandle(
    name: string,
    options?: {
      create?: boolean
    },
  ): Promise<FileSystemDirectoryHandle>
}

interface Window {
  showDirectoryPicker(options?: FilePickerOptions): Promise<FileSystemDirectoryHandle>
}
