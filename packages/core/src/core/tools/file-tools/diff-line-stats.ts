import { diffLines } from 'diff'

/**
 * 片段增删行数统计（改动账本 ChangeDiff 的唯一计数口径）。
 * 与 app 侧 DiffLines.vue 用同一个 diffLines、同一行数边界处理（去掉尾部一个换行再按 \n 切分），
 * 保证面板上的 +X −Y 与展开的红绿 diff 行数永远一致。真实 diff 计数天然非负，无需兜底。
 */
export function countDiffLines(oldText: string, newText: string): {
  linesAdded: number
  linesRemoved: number
} {
  let linesAdded = 0
  let linesRemoved = 0
  for (const part of diffLines(oldText, newText)) {
    const count = part.value.replace(/\n$/, '').split('\n').length
    if (part.added) {
      linesAdded += count
    } else if (part.removed) {
      linesRemoved += count
    }
  }
  return { linesAdded, linesRemoved }
}
