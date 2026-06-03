import { assertTextFilePath, normalizeProjectPath } from '../path'

export function asRecord(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}

export function readString(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`)
  }

  return value
}

export function assertMutableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  if (path === 'novel.config.json' || path.startsWith('.novel/')) {
    throw new Error(`${label} 不能指向项目配置或 .novel 内部文件`)
  }
}

export function normalizeTextFilePath(value: unknown, label: string) {
  const path = normalizeProjectPath(readString(value, label))
  assertTextFilePath(path)
  return path
}

export function countLines(content: string) {
  if (!content) {
    return 0
  }

  return content.replace(/\r\n/g, '\n').split('\n').length
}
