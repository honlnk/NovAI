import { describe, expect, it } from 'vitest'
import { $getRoot, $nodesOfType } from 'lexical'

import { useComposerBridge, type ComposerBridge } from '../../composables/useComposerBridge'
import { registerTextRefs, rescanTextRefs, scanTextRefs, TextRefNode } from './text-ref'

/**
 * token 高亮单测（输入框富文本化 W3）。
 * scanTextRefs 纯函数分支 + headless 集成（transform 建节点 / 编辑降级 / lexicon 重扫 /
 * 程序化整串重建后仍高亮——桥的 applyText 路径与 transform 的兼容性）。
 */

const LEXICON = {
  slash: ['/管理要素', '/生成项目记忆'],
  outline: ['@主线', '@暗线'],
}

/** 读出当前全部 TextRefNode 的文本（须在 editorState.read 内调用 $nodesOfType） */
function refTexts(bridge: ComposerBridge): string[] {
  return bridge.editor.getEditorState().read(() => $nodesOfType(TextRefNode).map((node) => node.getTextContent()))
}

describe('scanTextRefs 识别规则', () => {
  it('行首完整命令高亮（光标即结尾场景）', () => {
    expect(scanTextRefs('/管理要素', LEXICON)).toEqual([{ start: 0, end: 5, kind: 'slash' }])
  })

  it('命令后跟空白（补参数形态）高亮，范围不含尾空白', () => {
    expect(scanTextRefs('/管理要素 重点核对', LEXICON)).toEqual([{ start: 0, end: 5, kind: 'slash' }])
  })

  it('非行首（前文紧贴）不高亮', () => {
    expect(scanTextRefs('x/管理要素', LEXICON)).toEqual([])
  })

  it('命令后紧跟非空白字符（prose 提及）不高亮', () => {
    expect(scanTextRefs('/管理要素。', LEXICON)).toEqual([])
  })

  it('未注册命令 / 前缀不完整不高亮', () => {
    expect(scanTextRefs('/整理', LEXICON)).toEqual([])
    expect(scanTextRefs('/未知命令', LEXICON)).toEqual([])
  })

  it('空白后的命令高亮、多 token 全部识别、偏移正确', () => {
    const text = '写完这章 /生成项目记忆 再看看 @主线'
    expect(scanTextRefs(text, LEXICON)).toEqual([
      { start: 5, end: 12, kind: 'slash' },
      { start: 17, end: 20, kind: 'outline' },
    ])
  })

  it('跨行不跨段识别（换行前的贴字不算行首）', () => {
    expect(scanTextRefs('a/管理要素\n/管理要素', LEXICON)).toEqual([
      { start: 7, end: 12, kind: 'slash' },
    ])
  })

  it('大纲名精确匹配，@后接非 lexicon 名不高亮', () => {
    expect(scanTextRefs('看下 @主线 和 @新大纲', LEXICON)).toEqual([
      { start: 3, end: 6, kind: 'outline' },
    ])
  })

  it('投影不受影响的前提自查：TextRef 文本参与纯文本投影', () => {
    expect(scanTextRefs(' @主线', LEXICON)).toEqual([{ start: 1, end: 4, kind: 'outline' }])
  })
})

describe('headless 集成：transform 建节点与降级', () => {
  function createHighlightedBridge() {
    const bridge = useComposerBridge({ nodes: [TextRefNode] })
    registerTextRefs(bridge.editor, () => LEXICON)
    return bridge
  }

  it('setDraft 含命令时建 TextRefNode，投影文本不变', () => {
    const bridge = createHighlightedBridge()
    bridge.setDraft('/管理要素 重点核对第 12 章')
    expect(bridge.draft.value).toBe('/管理要素 重点核对第 12 章')
    expect(refTexts(bridge)).toEqual(['/管理要素'])
  })

  it('编辑后不再匹配则降级为普通文本节点', () => {
    const bridge = createHighlightedBridge()
    bridge.setDraft('/管理要素')
    expect(refTexts(bridge)).toEqual(['/管理要素'])
    bridge.setDraft('/管理要素x')
    expect(refTexts(bridge)).toEqual([])
    expect(bridge.draft.value).toBe('/管理要素x')
  })

  it('光标映射跨 TextRef 节点正确（着色分段不改坐标系）', () => {
    const bridge = createHighlightedBridge()
    bridge.setDraft('/管理要素 重点')
    expect(bridge.caretOffset()).toBe(8)
    bridge.setCaretOffset(3)
    expect(bridge.caretOffset()).toBe(3)
  })

  it('expandSlashCommand 对高亮态草稿照常展开（序列化不变回归）', async () => {
    const { expandSlashCommand } = await import('../../constants/slash-commands')
    const bridge = createHighlightedBridge()
    bridge.setDraft('/管理要素 重点核对第 12 章')
    expect(refTexts(bridge)).toEqual(['/管理要素'])
    // 发送链路读的是纯文本投影，与无高亮时逐字相同
    const message = expandSlashCommand(bridge.draft.value)
    expect(message).toContain('重点核对第 12 章')
    expect(message).not.toContain('/管理要素 重点核对第 12 章'.slice(0, 5))
  })

  it('大纲 token 同样高亮', () => {
    const bridge = createHighlightedBridge()
    bridge.setDraft('参考 @主线 的伏笔')
    expect(refTexts(bridge)).toEqual(['@主线'])
  })

  it('lexicon 变化后重扫生效（大纲列表动态加载场景）', () => {
    let lexicon = { slash: LEXICON.slash, outline: [] as string[] }
    const bridge = useComposerBridge({ nodes: [TextRefNode] })
    registerTextRefs(bridge.editor, () => lexicon)
    bridge.setDraft('看 @新大纲')
    expect(refTexts(bridge)).toEqual([])
    lexicon = { slash: LEXICON.slash, outline: ['@新大纲'] }
    rescanTextRefs(bridge.editor)
    expect(refTexts(bridge)).toEqual(['@新大纲'])
  })

  it('多段落各自行首命令分别高亮', () => {
    const bridge = createHighlightedBridge()
    bridge.setDraft('/生成项目记忆\n正文行\n再看 /管理要素')
    expect(refTexts(bridge)).toEqual(['/生成项目记忆', '/管理要素'])
    expect(bridge.draft.value).toBe('/生成项目记忆\n正文行\n再看 /管理要素')
  })
})

// 引用 $getRoot 仅为防止未使用告警的兜底不需要时移除——实际经由 refTexts/draft 断言覆盖
void $getRoot
