/**
 * 变更定位坐标（交互优化计划 §7）：为改动账本的 FileChangeRecord 补充「逐处原范围
 * 与新范围」，界面据此在内容面板中定位并呈现红绿差异，不自行搜索文本猜位置。
 *
 * 行号口径：1-based 闭区间 [start, end]，按统一源码行处理换行（纯文本与 Markdown
 * 源码同口径）。空范围用「start = 插入点行，end = start - 1」表达：
 * - 空文件填充（oldText=""）：oldStart=1, oldEnd=0；
 * - 替换为空（newText=""）：newEnd = newStart - 1。
 */

/** 文件内容版本标识（§7「前后内容版本」）：FNV-1a 内容哈希 + 写盘时刻 mtime */
export type FileVersion = {
  contentHash: string
  updatedAt: string
}

/** 一处替换的原范围与新范围（1-based 闭区间；空范围 end = start - 1） */
export type ChangeRange = {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
}

/** 一次写盘的定位信息：逐处范围 + 前后版本（created 无 beforeVersion） */
export type ChangeCoords = {
  ranges: ChangeRange[]
  beforeVersion?: FileVersion
  afterVersion?: FileVersion
}

/** 文本占用的行数：按换行切分（空串 0 行；'a' 1 行；'a\n' 2 行——含空末行） */
export function countTextLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++
  }
  return lines
}

/** 字符下标所在行（1-based）；index 落在换行符上算它开启的下一行 */
export function lineIndexOf(content: string, charIndex: number): number {
  let line = 1
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * 计算替换发生的逐处行范围。replaceAll 时枚举全部匹配处（顺序即出现顺序），
 * 否则只取第一处（与 EditFile 的 replace 语义一致——多处匹配且未开 replaceAll
 * 会被工具层拒绝，正常只到得了单处）。
 */
export function computeReplaceRanges(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): ChangeRange[] {
  // 空文件填充：原文为空（0 行），新内容落在文件开头
  if (oldText === '') {
    return [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: countTextLines(newText) }]
  }

  const oldLines = countTextLines(oldText)
  const newLines = countTextLines(newText)
  const ranges: ChangeRange[] = []

  let searchFrom = 0
  while (true) {
    const index = content.indexOf(oldText, searchFrom)
    if (index === -1) break
    const oldStart = lineIndexOf(content, index)
    ranges.push({
      oldStart,
      oldEnd: oldStart + oldLines - 1,
      newStart: oldStart,
      newEnd: newLines === 0 ? oldStart - 1 : oldStart + newLines - 1,
    })
    if (!replaceAll) break
    searchFrom = index + oldText.length
  }

  return ranges
}
