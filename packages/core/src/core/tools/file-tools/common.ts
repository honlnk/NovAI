import {
  assertTextFilePath,
  assertWritableTextFilePath,
  internalPathError,
  isInternalPath,
  isSpillReadablePath,
  normalizeProjectPath,
} from '../path'

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

/**
 * 内部路径判定与教学式报错全部来自 path.ts 的单一来源模块（内部文件屏蔽计划 D1/D5），
 * 本文件不再保留私有副本——名单与文案变更只改 path.ts 一处。
 */

export function assertMutableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  if (isInternalPath(path)) {
    throw internalPathError(label)
  }
}

export function assertWritableDocumentPath(path: string, label: string) {
  assertWritableTextFilePath(path)

  if (isInternalPath(path)) {
    throw internalPathError(label)
  }
}

/**
 * 读路径断言（ReadFile 专用）：内部路径整体禁读，唯独 `.novel/spill/` 放行——
 * spill 省略标记指引模型分段读回完整内容，这个口子就是取回通道。
 * spill 文件仍禁止写/改/删（写断言不含此例外）。
 */
export function assertReadableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  if (isInternalPath(path) && !isSpillReadablePath(path)) {
    throw internalPathError(label)
  }
}

/**
 * 读路径断言的目录版（SearchFiles 的搜索范围用）：与文件版同一套内部目录边界，
 * `.novel/spill/` 同样放行（模型可显式在 spill 目录内搜索）。
 */
export function assertReadableDirectoryPath(path: string, label: string) {
  if (isInternalPath(path) && !isSpillReadablePath(path)) {
    throw internalPathError(label)
  }
}

export function normalizeTextFilePath(value: unknown, label: string) {
  const path = normalizeProjectPath(readString(value, label))
  assertWritableTextFilePath(path)
  return path
}

export function countLines(content: string) {
  if (!content) {
    return 0
  }

  return content.replace(/\r\n/g, '\n').split('\n').length
}
