/**
 * 共享字符串 hash（FNV-1a 32 位）。
 *
 * 被 ReadFileState（文件过期检测）、RAG indexer（embedding 文本版本）、
 * Agent system prompt 刷新检测复用，保证三处算法一致。
 *
 * 按 UTF-16 code unit 计算（charCodeAt），与历史实现保持兼容。
 */
export function hashContent(content: string): string {
  let hash = 2166136261 // FNV offset basis

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619) // FNV prime
  }

  return `h${(hash >>> 0).toString(16)}`
}
