import { sharedMarkdown } from './markdown'

/**
 * 一个顶层块的渲染结果。key 取块起始行号（token.map[0]）：
 * 流式追加只会在文末生长或重塑最后一个块，前缀块的起始行号跨帧稳定，
 * Vue 按 key reconcile 而非 remount，前缀块 DOM 不被重建。
 */
export type MarkdownBlock = {
  key: number
  html: string
}

type ParsedTokens = ReturnType<typeof sharedMarkdown.parse>

/**
 * 按顶层块边界切块渲染（借鉴 dsh 的冻结前缀防线，Vue 版）。
 *
 * markdown-it 的 token 流里，顶层块 = nesting 深度回到 0 的连续段（paragraph/
 * heading/blockquote/list 各自成组，fence/hr 等自闭合 token 单独成组）。
 * 整篇 parse 一次（reference link 定义在 parse 阶段进 env，切块渲染不丢解析结果），
 * 逐块 renderer.render。每帧成本 = 全量 parse（纯 JS，数千字亚毫秒）+ 字符串渲染，
 * DOM 更新由 Vue 按 key 收敛到变化的尾部块——消除「每 token 整棵子树重建」。
 *
 * 已知偏差（与 dsh 相同）：流式期间块尚未闭合时，跨块的 reference-style link
 * 可能短暂按字面渲染，settled 后的完整 parse 自愈。
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  if (source.length === 0) {
    return []
  }

  const env = {}
  const tokens = sharedMarkdown.parse(source, env)

  const groups: ParsedTokens[] = []
  let current: ParsedTokens = []
  let depth = 0
  for (const token of tokens) {
    // 深度回到 0 且手上有完整组 → 上一组结束，新顶层块开始
    if (depth === 0 && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(token)
    depth += token.nesting
  }
  if (current.length > 0) {
    groups.push(current)
  }

  return groups.map((group, index) => ({
    key: blockKey(group, index),
    html: sharedMarkdown.renderer.render(group, sharedMarkdown.options, env),
  }))
}

/** 块的稳定 key：组内首个带位置信息 token 的起始行；无位置信息时退化为负序号（仅异常语法发生） */
function blockKey(group: ParsedTokens, index: number): number {
  for (const token of group) {
    if (token.map) {
      return token.map[0]
    }
  }
  return -(index + 1)
}
