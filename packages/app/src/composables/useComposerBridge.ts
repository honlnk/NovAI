import { ref, type Ref } from 'vue'

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  createEditor,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { registerHistory, createEmptyHistoryState } from '@lexical/history'
import { registerPlainText } from '@lexical/plain-text'

import { isImeComposing } from './keyboard'

/**
 * 输入框编辑器桥（输入框富文本化 W1）。
 *
 * Lexical（headless 用法，照 dsh composer 模式）是草稿的唯一真值；
 * `draft` 只是纯文本投影（段落 join '\n'），供发送 / 指令检测 / ghost 镜像读取。
 * ChatPanel 里所有「读草稿」的链路改读 draft，所有「写草稿」的链路走本桥的
 * setDraft / insertAtCaret / replaceTokenBeforeCaret——不再直接操纵 DOM 选区。
 *
 * 光标偏移采用纯文本坐标系（段间 '\n' 计一位），与 draft 的分行约定对齐；
 * 编辑器无 DOM root 时（headless 测试）同样可用，mount() 才接触 DOM。
 */

export interface ComposerBridge {
  editor: LexicalEditor
  /** 纯文本投影（段落 join '\n'）；唯一真值在编辑器里 */
  draft: Ref<string>
  mount: (el: HTMLElement) => void
  unmount: () => void
  /** 整串替换草稿（清根重建段落），光标落在末尾 */
  setDraft: (text: string) => void
  /** 光标的纯文本偏移；无选区（失焦等）返回 null，调用方按场景回退 draft 长度或 0 */
  caretOffset: () => number | null
  setCaretOffset: (offset: number) => void
  /** 在光标处插入文本并把光标移到插入内容之后（FIM 逐段采纳用） */
  insertAtCaret: (text: string) => void
  /**
   * 清除/替换光标前匹配指定正则的 token（@大纲、/命令共用）。
   * 正则锚定 beforeCursor 结尾；token 前的边界空白（(?:^|\s) 的捕获）保留。
   * 替换后光标落在替换文本之后并重新聚焦编辑器。返回是否发生了替换。
   */
  replaceTokenBeforeCaret: (re: RegExp, replacement?: string) => boolean
  /** 编辑器是否已挂到 DOM root */
  isMounted: () => boolean
  focus: () => void
  /**
   * 键盘事件是否处于输入法组字期（或 Safari compositionend 后 10ms 尾窗）。
   * 三条件合并（照 dsh keymap）：event 自带标记 + 桥监听的 composition 期 + 尾窗。
   */
  isComposing: (event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) => boolean
}

export interface ComposerBridgeOptions {
  /** 文本内容变化时回调（selection-only 更新不触发），挂 autoResize / 指令检测 / 补全调度 */
  onTextChange?: (text: string) => void
  /** 追加注册的节点类（如 W3 的 TextRefNode；Paragraph/Text 默认已注册） */
  nodes?: Klass<LexicalNode>[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 读 (node, offset) 在所属块（root 直接子级）内的文本偏移。
 * text 锚点 offset 是字符偏移；element 锚点 offset 是子节点下标（折算为前若干子节点的文本总量）。
 * node === block（锚在块自身，如空段被整体选中）时同理按下标折算。
 */
function $offsetInBlock(block: ElementNode, node: LexicalNode, offset: number): number | null {
  const sumChildrenText = (container: ElementNode, count: number): number => {
    const children = container.getChildren()
    let total = 0
    for (let i = 0; i < Math.min(count, children.length); i += 1) {
      total += children[i]!.getTextContent().length
    }
    return total
  }
  if (node === block) {
    return sumChildrenText(block, offset)
  }
  const walk = (container: ElementNode, base: number): number | null => {
    let acc = base
    for (const child of container.getChildren()) {
      if (child === node) {
        if (!$isElementNode(node)) {
          return acc + offset
        }
        return acc + sumChildrenText(node, offset)
      }
      if ($isElementNode(child)) {
        const found = walk(child, acc)
        if (found !== null) return found
      }
      acc += child.getTextContent().length
    }
    return null
  }
  return walk(block, 0)
}

/**
 * 纯文本投影：块（段落）文本 join 单个 '\n'。
 * 不用 $getRoot().getTextContent()——它的块间连接符是 '\n\n'（双换行），
 * 与本桥「段间 '\n' 计一位」的光标坐标系不一致，必须自投影保持读写对称。
 */
function $projectDraft(): string {
  const root = $getRoot()
  return root
    .getChildren()
    .map((block) => block.getTextContent())
    .join('\n')
}

/** 当前选区锚点的纯文本偏移（相对整篇草稿）；无 range 选区返回 null。 */function $readCaretOffset(): number | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  const anchor = selection.anchor
  const anchorNode = anchor.getNode()
  const root = $getRoot()
  if (anchorNode === root) return null

  // 锚点上溯到 root 直接子级（块）
  let block: LexicalNode = anchorNode
  while (block.getParent() !== null && block.getParent() !== root) {
    block = block.getParent()!
  }
  if (block.getParent() !== root || !$isElementNode(block)) return null

  let before = 0
  let foundBlock = false
  for (const child of root.getChildren()) {
    if (child === block) {
      foundBlock = true
      break
    }
    before += child.getTextContent().length + 1
  }
  if (!foundBlock) return null

  const inner = $offsetInBlock(block, anchorNode, anchor.offset)
  return inner === null ? null : before + inner
}

/** 把光标设置到纯文本偏移处（跨段折算；找不到文本节点时空块回退 selectEnd）。 */
function $selectAtOffset(target: number): void {
  const root = $getRoot()
  const blocks = root.getChildren()
  if (blocks.length === 0) {
    root.selectEnd()
    return
  }
  let remaining = target
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!
    const isLast = i === blocks.length - 1
    const length = block.getTextContent().length
    if (!isLast && remaining > length) {
      remaining -= length + 1
      continue
    }
    const inner = clamp(remaining, 0, length)
    const walk = (container: ElementNode): boolean => {
      let acc = 0
      for (const child of container.getChildren()) {
        if ($isTextNode(child)) {
          const childLength = child.getTextContent().length
          if (acc + childLength >= inner) {
            const selection = $createRangeSelection()
            const local = clamp(inner - acc, 0, childLength)
            selection.setTextNodeRange(child, local, child, local)
            $setSelection(selection)
            return true
          }
          acc += childLength
        } else if ($isElementNode(child)) {
          if (walk(child)) return true
        }
      }
      return false
    }
    if (!$isElementNode(block) || !walk(block)) {
      block.selectEnd()
    }
    return
  }
}

export function useComposerBridge(options: ComposerBridgeOptions = {}): ComposerBridge {
  const editor: LexicalEditor = createEditor({
    namespace: 'novai-composer',
    nodes: options.nodes ?? [],
    onError(error) {
      throw error
    },
  })
  registerPlainText(editor)
  // 与 dsh composer 同参数：1000ms 合并窗
  registerHistory(editor, createEmptyHistoryState(), 1000)

  const draft = ref('')
  let lastProjected = ''
  editor.registerUpdateListener(() => {
    const text = editor.getEditorState().read($projectDraft)
    if (text !== lastProjected) {
      lastProjected = text
      draft.value = text
      options.onTextChange?.(text)
    }
  })

  /** 整串重建（清根按行建段落）并把光标放到指定偏移——桥内所有写入的唯一落点。
   *  discrete 提交：状态同步生效，setDraft 返回后 draft / caretOffset 立即可读。 */
  function applyText(text: string, caret: number): void {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const lines = text.split('\n')
        for (const line of lines) {
          const paragraph = $createParagraphNode()
          if (line.length > 0) {
            paragraph.append($createTextNode(line))
          }
          root.append(paragraph)
        }
        $selectAtOffset(clamp(caret, 0, text.length))
      },
      { discrete: true },
    )
  }

  let rootEl: HTMLElement | null = null
  let composingActive = false
  let composingGuardUntil = 0
  const onCompositionStart = () => {
    composingActive = true
  }
  const onCompositionEnd = () => {
    composingActive = false
    composingGuardUntil = Date.now() + 10
  }

  function setDraft(text: string): void {
    applyText(text, text.length)
  }

  function caretOffset(): number | null {
    return editor.getEditorState().read($readCaretOffset)
  }

  function setCaretOffset(offset: number): void {
    editor.update(
      () => {
        $selectAtOffset(offset)
      },
      { discrete: true },
    )
  }

  function insertAtCaret(text: string): void {
    const caret = caretOffset() ?? draft.value.length
    applyText(draft.value.slice(0, caret) + text + draft.value.slice(caret), caret + text.length)
  }

  function replaceTokenBeforeCaret(re: RegExp, replacement = ''): boolean {
    const caret = caretOffset() ?? draft.value.length
    const beforeCursor = draft.value.slice(0, caret)
    const afterCursor = draft.value.slice(caret)
    let matched = false
    const cleaned = beforeCursor.replace(re, (match: string) => {
      matched = true
      const boundary = match.startsWith('/') || match.startsWith('@') ? '' : match.slice(0, 1)
      return `${boundary}${replacement}`
    })
    if (!matched) return false
    applyText(cleaned + afterCursor, cleaned.length)
    rootEl?.focus()
    return true
  }

  function unmount(): void {
    if (rootEl !== null) {
      editor.setRootElement(null)
      rootEl.removeEventListener('compositionstart', onCompositionStart)
      rootEl.removeEventListener('compositionend', onCompositionEnd)
      rootEl = null
    }
  }

  return {
    editor,
    draft,
    mount(el: HTMLElement) {
      if (rootEl === el) return
      unmount()
      rootEl = el
      // Lexical 0.49 契约：setRootElement 只接管事件与渲染，从不设置 contenteditable
      // （对照 dsh ComposerContentEditable.tsx：绑定层负责渲染可编辑性）——漏了它
      // 元素不可编辑且无任何报错，点击无光标。挂载即隐含可编辑，在此统一设置。
      el.contentEditable = 'true'
      editor.setRootElement(el)
      el.addEventListener('compositionstart', onCompositionStart)
      el.addEventListener('compositionend', onCompositionEnd)
    },
    unmount,
    setDraft,
    caretOffset,
    setCaretOffset,
    insertAtCaret,
    replaceTokenBeforeCaret,
    isMounted() {
      return rootEl !== null
    },
    focus() {
      rootEl?.focus()
    },
    isComposing(event) {
      return isImeComposing(event) || composingActive || Date.now() < composingGuardUntil
    },
  }
}
