/**
 * 聊天输入区（Lexical 编辑器宿主）自适应高度：auto → scrollHeight，上限 200px，超过后宿主内部滚动
 * （宿主样式见 style.css 的 .chat-input-editable：overflow-y: auto）。
 */
export const COMPOSER_MAX_HEIGHT = 200

/** 光标离上下边缘的容差：行高带小数（15px × 1.625），不留容差会被亚像素差值触发无意义的滚动 */
const CARET_EDGE_TOLERANCE = 1

/**
 * 量高度要先把宿主高度设回 auto，这一瞬间内容完全展开、不再溢出，浏览器随即把 scrollTop 钳回 0，
 * 高度恢复后滚动位置不会自己回来。长草稿（超过上限）里每次文本变化都会走到这里：删除时没有东西
 * 把视口拉回去，表现为每删一个字就跳回最开头。所以量完先把滚动位置还回去。
 */
export function fitComposerHeight(host: HTMLElement): void {
  const { scrollTop, scrollLeft } = host
  host.style.height = 'auto'
  host.style.height = `${Math.min(host.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  // 内容变短（删掉整行等）时旧位置已超出可滚范围，浏览器会钳到新的最大值
  host.scrollTop = scrollTop
  host.scrollLeft = scrollLeft
  revealCaret(host)
}

/**
 * 光标被宿主上下边缘挡住时按最小滚动量移进视野，内容在末尾增长后视口跟着光标走。
 * Chromium 对落在聚焦编辑区里的选区会自己做这一步，这里补齐是为了不依赖它。
 * 只在编辑器持有焦点时介入（输入、删除、接受补全都在焦点内）；焦点在别的控件上时不把视口拉走。
 * 只滚宿主这一个滚动容器，不波及外层页面。
 */
function revealCaret(host: HTMLElement): void {
  const doc = host.ownerDocument
  if (doc.activeElement !== host) return
  const selection = doc.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
  // 有选区、或光标不在宿主里：不介入
  if (!range?.collapsed || !host.contains(range.startContainer)) return
  const caret = caretBox(range)
  if (caret.height === 0) return
  const box = host.getBoundingClientRect()
  if (caret.top < box.top - CARET_EDGE_TOLERANCE) {
    host.scrollTop -= box.top - caret.top
  } else if (caret.bottom > box.bottom + CARET_EDGE_TOLERANCE) {
    host.scrollTop += caret.bottom - box.bottom
  }
}

/**
 * 光标占的那一行的盒子。空行（刚按过 Shift+Enter）上的光标量不出矩形，改用它所在段落的盒子。
 */
function caretBox(range: Range): DOMRect {
  const rects = range.getClientRects()
  if (rects.length > 0) return rects[0]
  const container = range.startContainer
  if (container.nodeType === 1 && container.textContent === '') {
    return (container as Element).getBoundingClientRect()
  }
  return range.getBoundingClientRect()
}
