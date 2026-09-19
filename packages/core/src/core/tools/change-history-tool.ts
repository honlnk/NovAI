import type { FileChangeRecord } from '../../types/chat'
import type {
  GetFileChangeHistoryInput,
  GetFileChangeHistoryOutput,
  ToolDefinition,
} from './types'

/**
 * 会话文件修改历史查询（只读，按需取回）：压缩后模型想回忆「此前改过哪些文件」时自己调。
 * 不长期注入任何内容——可发现性只靠工具 description（dsh 验证的模式）。
 * 结果自控 limit，不进 SPILLABLE_TOOLS。
 */

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export const getFileChangeHistoryTool: ToolDefinition<
  'GetFileChangeHistory',
  GetFileChangeHistoryInput,
  GetFileChangeHistoryOutput
> = {
  name: 'GetFileChangeHistory',
  description: '查询本会话此前的文件修改历史（改了哪些文件、什么时间、增删行数）；当你需要回忆或核对之前的改动时使用。',
  validateInput(input) {
    const value = asRecord(input)
    const rawLimit = typeof value.limit === 'number' ? value.limit : undefined
    const limit = rawLimit === undefined ? DEFAULT_LIMIT : clampLimit(rawLimit)

    return {
      limit,
      ...(typeof value.path === 'string' && value.path.trim() ? { path: value.path.trim() } : {}),
      ...(typeof value.runId === 'string' && value.runId.trim() ? { runId: value.runId.trim() } : {}),
    }
  },
  async run(input, runtime) {
    const ledger = runtime.getChangeLedger?.() ?? []

    const matched = ledger.filter((record) => {
      if (input.runId && record.runId !== input.runId) {
        return false
      }
      if (input.path && !recordTouchesPath(record, input.path)) {
        return false
      }
      return true
    })

    // 新→旧：账本是追加序（旧→新），倒序后取前 limit 条
    const ordered = [...matched].reverse().slice(0, input.limit)

    if (ordered.length === 0) {
      return {
        content: input.path || input.runId
          ? '没有匹配条件的文件修改记录。'
          : '本会话暂无文件修改记录。',
        totalCount: matched.length,
        returnedCount: 0,
      }
    }

    const lines = ordered.map((record) => formatRecord(record))
    return {
      content: [
        ...lines,
        `共 ${matched.length} 条记录${matched.length > ordered.length ? `（仅显示最近 ${ordered.length} 条，可加大 limit 或用 path/runId 过滤）` : ''}`,
      ].join('\n'),
      totalCount: matched.length,
      returnedCount: ordered.length,
    }
  },
  summarizeInput(input) {
    const scope = [input.path, input.runId ? `轮次 ${input.runId}` : undefined]
      .filter(Boolean)
      .join('，')
    return `查询文件修改历史${scope ? `（${scope}）` : ''}`
  },
  summarizeOutput(output) {
    return output.returnedCount > 0
      ? `返回 ${output.returnedCount} 条修改记录`
      : '本会话暂无文件修改记录'
  },
}

function recordTouchesPath(record: FileChangeRecord, path: string): boolean {
  if (record.change.type === 'renamed') {
    return record.change.fromPath === path || record.change.toPath === path
  }
  return record.change.path === path
}

function formatRecord(record: FileChangeRecord): string {
  const time = formatTime(record.at)
  const diffSuffix = record.diff
    ? ` (+${record.diff.linesAdded} −${record.diff.linesRemoved})`
    : ''

  if (record.change.type === 'renamed') {
    return `[${time}] 改名 ${record.change.fromPath} → ${record.change.toPath}${diffSuffix}`
  }
  if (record.change.type === 'deleted') {
    return `[${time}] 删除 ${record.change.path}`
  }
  const label = record.change.type === 'created' ? '新建' : '修改'
  return `[${time}] ${label} ${record.change.path}${diffSuffix}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT)
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}
