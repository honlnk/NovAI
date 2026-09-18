import { assertTextFilePath, assertWritableTextFilePath, normalizeProjectPath } from '../path'

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
 * 内部路径硬底线的统一判定。比较前统一小写：macOS APFS 大小写不敏感，
 * `Novel.Config.JSON` / `.NOVEL/` 变体同样命中真实内部文件，必须一并拦截。
 */
function foldInternalPath(path: string) {
  return path.toLowerCase()
}

function isInternalPath(folded: string) {
  return folded === 'novel.config.json' || folded.startsWith('.novel/')
}

/** spill 目录是内部目录中唯一放行读取的例外（详见 spill 重设计：省略标记必须可取回）。 */
const SPILL_DIR_PREFIX = '.novel/spill/'

export function assertMutableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  if (isInternalPath(foldInternalPath(path))) {
    throw new Error(`${label} 不能指向项目配置或 .novel 内部文件`)
  }
}

export function assertWritableDocumentPath(path: string, label: string) {
  assertWritableTextFilePath(path)

  if (isInternalPath(foldInternalPath(path))) {
    throw new Error(`${label} 不能指向项目配置或 .novel 内部文件`)
  }
}

/**
 * 读路径断言（ReadFile 专用）：`.novel/` 仍整体禁读，唯独 `.novel/spill/` 放行——
 * spill 省略标记指引模型分段读回完整内容，这个口子就是取回通道。
 * spill 文件仍禁止写/改/删（写断言不含此例外）。
 */
export function assertReadableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  const folded = foldInternalPath(path)
  if (isInternalPath(folded) && !folded.startsWith(SPILL_DIR_PREFIX)) {
    throw new Error(`${label} 不能指向项目配置或 .novel 内部文件（.novel/spill/ 除外）`)
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
