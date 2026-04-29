import { normalizeProjectDirectoryPath } from './path'
import type {
  ListDirectoryEntry,
  ListDirectoryInput,
  ListDirectoryOutput,
  ToolDefinition,
} from './types'

export const listDirectoryTool: ToolDefinition<'ListDirectory', ListDirectoryInput, ListDirectoryOutput> = {
  name: 'ListDirectory',
  description: '查看当前小说项目中某个目录的直接文件结构。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectDirectoryPath(readOptionalString(value.path, 'ListDirectory.path'))

    return {
      path: path || undefined,
      showHidden: typeof value.showHidden === 'boolean' ? value.showHidden : false,
    }
  },
  async run(input, runtime) {
    const directoryPath = input.path ?? ''
    const directoryHandle = await resolveDirectoryHandle(runtime.project.handle, directoryPath)
    const entries: ListDirectoryEntry[] = []

    for await (const entry of directoryHandle.values()) {
      const hidden = entry.name.startsWith('.')

      if (hidden && !input.showHidden) {
        continue
      }

      entries.push({
        name: entry.name,
        path: directoryPath ? `${directoryPath}/${entry.name}` : entry.name,
        kind: entry.kind,
        hidden,
      })
    }

    return {
      path: directoryPath,
      entries: sortEntries(entries),
    }
  },
  summarizeInput(input) {
    const target = input.path || '项目根目录'
    return input.showHidden
      ? `查看 ${target} 的目录结构，包括隐藏项`
      : `查看 ${target} 的目录结构`
  },
  summarizeOutput(output) {
    const target = output.path || '项目根目录'
    return `已查看 ${target}，共 ${output.entries.length} 个条目`
  },
}

function asRecord(input: unknown) {
  if (input === undefined || input === null) {
    return {}
  }

  if (typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}

function readOptionalString(value: unknown, label: string) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`)
  }

  return value
}

async function resolveDirectoryHandle(rootHandle: FileSystemDirectoryHandle, path: string) {
  const segments = path.split('/').filter(Boolean)
  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current
}

function sortEntries<TEntry extends { name: string; kind: 'file' | 'directory' }>(entries: TEntry[]) {
  return entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
}
