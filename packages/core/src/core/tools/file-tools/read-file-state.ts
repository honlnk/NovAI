import { hashContent } from '../../util/hash'
import { normalizeProjectPath } from '../path'
import type { ReadFileState } from '../types'
import { asRecord, readString } from './common'

export function readReadFileState(value: unknown, label: string): ReadFileState {
  const state = asRecord(value)
  const path = normalizeProjectPath(readString(state.path, `${label}.path`))
  const contentHash = readString(state.contentHash, `${label}.contentHash`)
  const lastModified = readString(state.lastModified, `${label}.lastModified`)
  const fileSizeBytes = state.fileSizeBytes

  if (!Number.isInteger(fileSizeBytes) || Number(fileSizeBytes) < 0) {
    throw new Error(`${label}.fileSizeBytes 必须是非负整数`)
  }

  return {
    path,
    contentHash,
    lastModified,
    fileSizeBytes: Number(fileSizeBytes),
  }
}

export function createReadFileState(path: string, content: string, file: File): ReadFileState {
  return {
    path,
    contentHash: hashContent(content),
    lastModified: new Date(file.lastModified).toISOString(),
    fileSizeBytes: file.size,
  }
}

export function assertFreshReadFileState(
  path: string,
  expectedState: ReadFileState,
  currentState: ReadFileState,
) {
  if (expectedState.path !== path) {
    throw new Error(`EditFile.readFileState.path 与目标文件不一致：读取的是 ${expectedState.path}，准备修改的是 ${path}`)
  }

  if (expectedState.contentHash !== currentState.contentHash) {
    throw new Error(`文件 ${path} 已在 ReadFile 之后发生变化；请重新 ReadFile 获取最新内容后再 EditFile，避免覆盖他人或其他工具的修改`)
  }
}
