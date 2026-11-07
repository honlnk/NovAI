import { getProjectTextFile } from '../../fs/project-fs'
import { hashContent } from '../../util/hash'
import { normalizeProjectPath } from '../path'
import type { ReadFileState, ToolRuntime } from '../types'
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

  const sourceTool = state.sourceTool === 'Edit' ? 'Edit' : state.sourceTool === 'Read' ? 'Read' : undefined

  return {
    path,
    contentHash,
    lastModified,
    fileSizeBytes: Number(fileSizeBytes),
    ...(sourceTool ? { sourceTool } : {}),
  }
}

export function createReadFileState(path: string, content: string, file: File): ReadFileState {
  return {
    path,
    contentHash: hashContent(content),
    lastModified: new Date(file.lastModified).toISOString(),
    fileSizeBytes: file.size,
    sourceTool: 'Read',
  }
}

/**
 * EditFile 写入成功后刷新读取状态（D2）：条目更新为刚写入的新内容（新 hash、新 mtime、
 * 新 size），标记 sourceTool: 'Edit'——模型连续编辑同一文件时不再需要重新 ReadFile。
 * 需要重新取一次文件句柄拿写入后的真实 mtime/size（内容本身已知，不必重读文本）。
 * 返回刷新后的状态供调用方复用（改动账本记 afterVersion 免二次取句柄）；
 * 无读取状态注册表时仍计算并返回，只是不落表。
 */
export async function updateReadFileStateAfterWrite(
  runtime: Pick<ToolRuntime, 'project' | 'readFileStates'>,
  path: string,
  nextContent: string,
): Promise<ReadFileState> {
  const file = await getProjectTextFile(runtime.project.handle, path)
  const state: ReadFileState = {
    path,
    contentHash: hashContent(nextContent),
    lastModified: new Date(file.lastModified).toISOString(),
    fileSizeBytes: file.size,
    sourceTool: 'Edit',
  }
  runtime.readFileStates?.set(path, state)
  return state
}

export function assertFreshReadFileState(
  path: string,
  expectedState: ReadFileState,
  currentState: ReadFileState,
) {
  if (expectedState.path !== path) {
    throw new Error(`EditFile.readFileState.path 与目标文件不一致：读取的是 ${expectedState.path}，准备修改的是 ${path}`)
  }

  // mtime + size 优先（对齐 ZCode hasReadStateChanged 的整数毫秒口径）：
  // 两项都没变 → 直接放行，不比 hash（连续编辑免重读的净效果）；
  // 任一项有变化信号（mtime 变新或大小改变）→ contentHash 兜底定夺：
  // hash 仍相同（外部 touch 未改内容）放行，hash 不同才判 stale。
  const expectedMtimeMs = parseTimestampMs(expectedState.lastModified)
  const currentMtimeMs = parseTimestampMs(currentState.lastModified)

  if (expectedMtimeMs !== null && currentMtimeMs !== null) {
    const mtimeAdvanced = currentMtimeMs > expectedMtimeMs
    const sizeChanged = expectedState.fileSizeBytes !== currentState.fileSizeBytes

    if (!mtimeAdvanced && !sizeChanged) {
      return
    }

    if (expectedState.contentHash === currentState.contentHash) {
      return
    }
  } else if (expectedState.contentHash === currentState.contentHash) {
    // 时间戳不可解析（防御分支，正常链路不会出现）：退回纯 hash 比对
    return
  }

  throw new Error(`文件 ${path} 已在 ReadFile 之后发生变化；请重新 ReadFile 获取最新内容后再 EditFile，避免覆盖他人或其他工具的修改`)
}

/** ISO 时间串 → 整数毫秒；不可解析返回 null（对齐 ZCode normalizeReadFileStateMtimeMs 的降级语义）。 */
function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : Math.trunc(ms)
}
