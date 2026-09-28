import MarkdownIt from 'markdown-it'

/**
 * 全应用共享的 MarkdownIt 单例。
 * 原为每个 MarkdownRenderer 组件实例各建一个（N 条消息 = N 个解析器实例），
 * 纯内存浪费；MarkdownIt 无会话级状态，可安全共享。
 * 配置与原 MarkdownRenderer 一致：不放开 HTML、linkify、typographer。
 */
export const sharedMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

/** 整篇渲染：块级渲染的等价对比基线（测试用），也供简单场景直接调用 */
export function renderMarkdown(text: string): string {
  return sharedMarkdown.render(text)
}
