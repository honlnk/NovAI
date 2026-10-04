import {
  $nodesOfType,
  mergeRegister,
  TextNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedTextNode,
} from 'lexical'
import { registerLexicalTextEntity } from '@lexical/text'

/**
 * 命令/大纲 token 高亮（输入框富文本化 W3，方案照 dsh text-ref.ts）。
 *
 * TextRefNode extends TextNode：着色靠 createDOM 加 class（保持普通文本语义、
 * 可继续编辑），编辑后不再匹配识别规则时由 registerLexicalTextEntity 自动降回
 * 普通 TextNode。非 chip（原子节点）方案——计划 D3 拍板。
 *
 * 识别规则（纯函数 scanTextRefs，与 dsh decorations.ts 同构，中文名适配）：
 * 触发符 / 或 @ 必须在行首或空白后；name 为连续非空白段（[^\s@/]+）；
 * `/名字` 整体精确命中 lexicon 且其后紧跟空白或结尾才高亮——
 * `/整理要素。`、`x/整理要素`、`/整理` 都不高亮。
 */

export type TextRefKind = 'slash' | 'outline'

export class TextRefNode extends TextNode {
  readonly __kind: TextRefKind

  constructor(text: string, kind: TextRefKind, key?: NodeKey) {
    super(text, key)
    this.__kind = kind
  }

  static override getType(): string {
    return 'novai-text-ref'
  }

  static override clone(node: TextRefNode): TextRefNode {
    return new TextRefNode(node.__text, node.__kind, node.__key)
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.classList.add('chat-text-ref')
    return dom
  }

  /** 实体节点：不与普通兄弟文本节点合并（着色边界稳定） */
  override isTextEntity(): boolean {
    return true
  }

  // 参数用基类宽签名（Klass 契约按逆变检查，窄参数过不了 typecheck）；草稿不落盘
  // 序列化，这里按 SerializedTextRefNode 读字段兜底即可
  static override importJSON(
    serializedNode: SerializedLexicalNode & Record<string, unknown>,
  ): TextRefNode {
    const data = serializedNode as unknown as SerializedTextRefNode
    const node = new TextRefNode(data.text, data.kind === 'outline' ? 'outline' : 'slash')
    node.setFormat(data.format)
    node.setDetail(data.detail)
    node.setMode(data.mode)
    node.setStyle(data.style)
    return node
  }

  override exportJSON(): SerializedTextRefNode {
    return { ...super.exportJSON(), type: TextRefNode.getType(), kind: this.__kind }
  }
}

interface SerializedTextRefNode extends SerializedTextNode {
  kind: TextRefKind
}

export interface TextRefLexicon {
  /** 斜杠命令 label 集（含 / 前缀，如 '/整理要素'） */
  slash: readonly string[]
  /** 大纲引用集（含 @ 前缀，如 '@主线'） */
  outline: readonly string[]
}

export interface TextRefMatch {
  /** 起始偏移（含触发符） */
  start: number
  /** 结束偏移（不含其后的空白） */
  end: number
  kind: TextRefKind
}

const TOKEN_RE = /(^|\s)([/@])([^\s@/]+)/g

/**
 * 扫描文本中所有可高亮的命令/大纲 token。
 * 纯函数、不跨行（[^\s@/]+ 天然不含 \n）；token 后必须紧跟空白或结尾。
 */
export function scanTextRefs(text: string, lexicon: TextRefLexicon): TextRefMatch[] {
  const slashSet = new Set(lexicon.slash)
  const outlineSet = new Set(lexicon.outline)
  const matches: TextRefMatch[] = []
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const trigger = match[2]!
    const name = match[3]!
    const label = `${trigger}${name}`
    const kind: TextRefKind = trigger === '/' ? 'slash' : 'outline'
    const set = kind === 'slash' ? slashSet : outlineSet
    if (!set.has(label)) continue
    const end = match.index + match[0].length
    if (!/^(?:\s|$)/.test(text.slice(end))) continue
    matches.push({ start: end - label.length, end, kind })
  }
  return matches
}

/** 在编辑器上注册 token 高亮（transform + 实体降级）；返回注销函数。 */
export function registerTextRefs(
  editor: LexicalEditor,
  getLexicon: () => TextRefLexicon,
): () => void {
  // registerLexicalTextEntity 返回注销函数数组，按其契约用 mergeRegister 收敛成单个
  return mergeRegister(
    ...registerLexicalTextEntity(
      editor,
      // getMatch 收到的是累积文本字符串（@lexical/text 契约），不是节点
      (text) => {
        const match = scanTextRefs(text, getLexicon())[0]
        return match ? { start: match.start, end: match.end } : null
      },
      TextRefNode,
      (textNode) => {
        const text = textNode.getTextContent()
        return new TextRefNode(text, text.startsWith('@') ? 'outline' : 'slash')
      },
    ),
  )
}

/** lexicon 变化（如大纲列表刷新）后的全量重扫：把所有文本节点标脏触发 transform。 */
export function rescanTextRefs(editor: LexicalEditor): void {
  editor.update(
    () => {
      for (const node of $nodesOfType(TextNode)) {
        node.markDirty()
      }
    },
    { discrete: true },
  )
}
