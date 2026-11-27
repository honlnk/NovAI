import { sharedMarkdown } from './markdown'
import { splitFrontmatter } from './frontmatter-display'

/**
 * 一个顶层块的渲染结果。key 取块起始行号（token.map[0]）：
 * 流式追加只会在文末生长或重塑最后一个块，前缀块的起始行号跨帧稳定，
 * Vue 按 key reconcile 而非 remount，前缀块 DOM 不被重建。
 */
export type MarkdownBlock = {
  key: number
  html: string
  /**
   * frontmatter 特殊块：html 恒为空串，渲染方以卡片呈现 raw（文件预览卡片化计划 Step 1）；
   * code：顶层代码围栏，html 照常是 pre/code，渲染方额外加复制栏
   */
  kind?: 'frontmatter' | 'code'
  /** kind === 'frontmatter' 时的围栏全文（含两行分隔线） */
  raw?: string
  /** kind === 'code' 时的围栏内原文（含结尾换行；流式中未闭合的围栏没有），复制用 */
  code?: string
  /** kind === 'code' 时的语言名（围栏信息串首词）；没写语言则缺省 */
  lang?: string
}

type ParsedTokens = ReturnType<typeof sharedMarkdown.parse>
type RenderEnv = Parameters<typeof sharedMarkdown.renderer.render>[2]

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
 *
 * options.detectFrontmatter（默认关，聊天路径零变化）：识别文件开头的 YAML
 * frontmatter 围栏（splitFrontmatter 的识别门槛），把围栏的 hr + setext h2 两组
 * 丢弃、换成单个 kind='frontmatter' 特殊块（key=0，html 空，raw 为围栏全文）。
 * 正文块 key 仍取全源行号——高亮映射（markdownBlockIndicesInRange）无需感知。
 */
export function parseMarkdownBlocks(
  source: string,
  options?: { detectFrontmatter?: boolean },
): MarkdownBlock[] {
  if (source.length === 0) {
    return []
  }

  const env = {}
  const tokens = sharedMarkdown.parse(source, env)
  const groups = groupTopLevel(tokens)

  if (options?.detectFrontmatter === true) {
    const split = splitFrontmatter(source)
    if (split.hasFrontmatter) {
      const closeLine = split.raw.split('\n').length - 1
      const blocks: MarkdownBlock[] = [{ key: 0, html: '', kind: 'frontmatter', raw: split.raw }]
      for (const [index, group] of groups.entries()) {
        const start = blockStartLine(group)
        // 围栏覆盖的 hr 与 setext h2 两组丢弃（正文块起始行必然 > 闭合线行号）
        if (start !== null && start <= closeLine) {
          continue
        }
        blocks.push(renderBlock(group, index, env))
      }
      return blocks
    }
  }

  return groups.map((group, index) => renderBlock(group, index, env))
}

/** 一个顶层 token 组 → 渲染结果（key 取组起始行号；顶层代码围栏附带原文与语言） */
function renderBlock(group: ParsedTokens, index: number, env: RenderEnv): MarkdownBlock {
  const block: MarkdownBlock = {
    key: blockStartLine(group) ?? -(index + 1),
    html: sharedMarkdown.renderer.render(group, sharedMarkdown.options, env),
  }
  // 顶层代码围栏自成一个 token 组：标为代码块，渲染方据此加复制栏（嵌在列表/引用里的围栏不算）
  const fence = group.length === 1 ? group[0] : undefined
  if (fence?.type !== 'fence') {
    return block
  }
  const lang = fence.info.trim().split(/\s+/)[0]
  return {
    ...block,
    kind: 'code',
    code: fence.content,
    ...(lang ? { lang } : {}),
  }
}

/** 深度回到 0 的连续 token 段为一个顶层块 */
function groupTopLevel(tokens: ParsedTokens): ParsedTokens[] {
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
  return groups
}

/** 组内首个带位置信息 token 的起始行；无位置信息时为 null（仅异常语法发生） */
function blockStartLine(group: ParsedTokens): number | null {
  for (const token of group) {
    if (token.map) {
      return token.map[0]
    }
  }
  return null
}
