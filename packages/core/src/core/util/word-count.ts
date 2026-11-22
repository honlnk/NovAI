/**
 * 稿件字数统计（交互优化计划 §6）：统计非空白字符（含标点），空文件为 0。
 * 口径与排版无关，只看文本内容本身。
 *
 * - 纯文本章节：首行符合既有「第 + 编号 + 章 + 空白 + 标题」约定时排除标题行
 *   （标题不是正文）；其余行全部计入。
 * - Markdown：先剥离为纯文本再统计——排除标记符号、链接地址、frontmatter 元信息
 *   头和代码块语言标记；普通文字与代码块内的实际代码内容计入。
 */

/** 章节文件首行的标题约定（正文第一行「第001章 东宫听讼」形态，编号与标题间有空白） */
export const CHAPTER_TITLE_LINE_PATTERN = /^第\d+章\s+\S/

/** frontmatter 元信息头：文件开头的 --- 包裹块（YAML），整体不属于正文 */
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

/**
 * 统计纯文本的非空白字符数。chapterTitle 为 true 且首行是章节标题时排除首行。
 */
export function countPlainTextChars(text: string, options?: { chapterTitle?: boolean }): number {
  let body = text
  if (options?.chapterTitle) {
    const newlineIndex = text.indexOf('\n')
    const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex)
    if (CHAPTER_TITLE_LINE_PATTERN.test(firstLine)) {
      body = newlineIndex === -1 ? '' : text.slice(newlineIndex + 1)
    }
  }
  return countNonWhitespace(body)
}

/**
 * Markdown 剥离为纯文本：去 frontmatter、代码围栏语言标记、行内与结构标记、
 * 链接/图片地址（保留链接文字与图片替代文本）、HTML 标签。代码块内容计入。
 */
export function stripMarkdownToText(markdown: string): string {
  let text = markdown

  // 元信息头：开头的 frontmatter 块整体移除
  text = text.replace(FRONTMATTER_PATTERN, '')

  // 代码围栏：去掉围栏行（含语言标记），保留围栏内的代码内容
  text = text.replace(/^(```|~~~)[^\n]*$/gm, '')

  // 图片：保留替代文本，丢弃地址 ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内链接：保留链接文字，丢弃地址 [text](url)
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 引用定义：[id]: url 整行是地址元数据，丢弃
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')

  // HTML 标签：去掉标签本身，保留内部文本
  text = text.replace(/<[^>]+>/g, '')

  // 行结构标记（逐行）：标题 #、引用 >、列表标记 - * + 或有序数字、表格分隔行
  text = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
  // 表格单元格分隔线 | 保留文字内容
  text = text.replace(/\|/g, '')

  // 行内强调标记：** * _ ~~ ` ==
  text = text.replace(/(\*\*|__|~~|==)/g, '')
  text = text.replace(/(?<![\w*])\*(?!\s)([^*\n]*?)(?<!\s)\*(?![\w*])/g, '$1')
  text = text.replace(/(?<![\w_])_(?!\s)([^_\n]*?)(?<!\s)_(?![\w_])/g, '$1')
  text = text.replace(/`([^`\n]*)`/g, '$1')

  return text
}

/** Markdown 稿件的非空白字符数（剥离标记后统计） */
export function countMarkdownChars(markdown: string): number {
  return countNonWhitespace(stripMarkdownToText(markdown))
}

/** 内容面板稿件字数：按格式分发（markdown 走剥离，text 章节排除标题行） */
export function countContentChars(
  text: string,
  format: 'text' | 'markdown' | 'json',
  options?: { isChapter?: boolean },
): number {
  if (format === 'markdown') {
    return countMarkdownChars(text)
  }
  if (format === 'text') {
    return countPlainTextChars(text, { chapterTitle: options?.isChapter ?? false })
  }
  return 0
}

function countNonWhitespace(text: string): number {
  const matches = text.match(/\S/g)
  return matches ? matches.length : 0
}
