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

// 聊天正文里的链接一律新标签打开：SPA 内 <a> 默认当前页跳转会把整个应用顶掉。
// html:false 下所有链接都经 link_open 规则产出（含 linkify 自动识别），覆盖一处即全局生效；
// noopener noreferrer 防 target=_blank 的反向 tab-nabbing。
const defaultLinkOpen =
  sharedMarkdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

sharedMarkdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  setAttr(token, 'target', '_blank')
  setAttr(token, 'rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

function setAttr(token: ReturnType<MarkdownIt['parse']>[number], name: string, value: string): void {
  const index = token.attrIndex(name)
  if (index < 0) {
    token.attrPush([name, value])
  } else {
    token.attrs![index][1] = value
  }
}

/** 整篇渲染：块级渲染的等价对比基线（测试用），也供简单场景直接调用 */
export function renderMarkdown(text: string): string {
  return sharedMarkdown.render(text)
}
