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
  // .novai/ 为项目级隐藏配置目录（要素管理员快捷选项等，要素整理参数化 W2），与 novel.config.json 同级保护
  return folded === 'novel.config.json' || folded.startsWith('.novel/') || folded.startsWith('.novai/')
}

/** spill 目录是内部目录中唯一放行读取的例外（详见 spill 重设计：省略标记必须可取回）。 */
const SPILL_DIR_PREFIX = '.novel/spill/'

export function assertMutableDocumentPath(path: string, label: string) {
  assertTextFilePath(path)

  if (isInternalPath(foldInternalPath(path))) {
    throw new Error(`${label} 不能指向项目内部文件（novel.config.json、.novel、.novai）`)
  }
}

export function assertWritableDocumentPath(path: string, label: string) {
  assertWritableTextFilePath(path)

  if (isInternalPath(foldInternalPath(path))) {
    throw new Error(`${label} 不能指向项目内部文件（novel.config.json、.novel、.novai）`)
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
    throw new Error(`${label} 不能指向项目内部文件（novel.config.json、.novel、.novai；.novel/spill/ 除外）`)
  }
}

/**
 * 读路径断言的目录版（SearchFiles 的搜索范围用）：与文件版同一套内部目录边界，
 * `.novel/spill/` 同样放行（模型可显式在 spill 目录内搜索）。目录路径不带尾斜杠，
 * spill 目录自身（`.novel/spill`）也算放行范围。
 */
export function assertReadableDirectoryPath(path: string, label: string) {
  const folded = foldInternalPath(path)
  // 目录路径不带尾斜杠：裸目录名（.novel、.novai 本身）也算内部目录
  const isInternal = folded === '.novel' || folded === '.novai' || isInternalPath(folded)

  if (isInternal && !isSpillDirectory(folded)) {
    throw new Error(`${label} 不能指向项目内部目录（novel.config.json、.novel、.novai；.novel/spill/ 除外）`)
  }
}

/** 是否落在放行的 spill 目录内（目录本身或其子路径）。 */
function isSpillDirectory(folded: string) {
  return folded === SPILL_DIR_PREFIX.slice(0, -1) || folded.startsWith(SPILL_DIR_PREFIX)
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
