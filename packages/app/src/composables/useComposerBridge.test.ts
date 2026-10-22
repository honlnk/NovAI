import { describe, expect, it } from 'vitest'
import { $setSelection } from 'lexical'

import { useComposerBridge } from './useComposerBridge'

/**
 * 编辑器桥的 headless 单测（输入框富文本化 W1）。
 * 无 DOM root，纯模型层验证：投影、光标双向映射、写入原语、token 替换。
 */

const SLASH_COMMAND_RE = /(?:^|\s)\/([^\s/]*)$/
const OUTLINE_COMMAND_RE = /(?:^|\s)@([^\s@]*)$/

function createBridge() {
  const changes: string[] = []
  const bridge = useComposerBridge({ onTextChange: (text) => changes.push(text) })
  return { bridge, changes }
}

describe('useComposerBridge 投影与写入', () => {
  it('setDraft 多行文本投影为段落 join 换行，光标落末尾', () => {
    const { bridge } = createBridge()
    bridge.setDraft('第一行\n第二行')
    expect(bridge.draft.value).toBe('第一行\n第二行')
    expect(bridge.caretOffset()).toBe(7)
  })

  it('setDraft 空串得到空草稿，光标为 0（空段折算）', () => {
    const { bridge } = createBridge()
    bridge.setDraft('')
    expect(bridge.draft.value).toBe('')
    expect(bridge.caretOffset()).toBe(0)
  })

  it('onTextChange 在文本变化时触发一次', () => {
    const { bridge, changes } = createBridge()
    bridge.setDraft('abc')
    bridge.setDraft('abc')
    bridge.setCaretOffset(1)
    expect(changes).toEqual(['abc'])
  })

  it('中文与中英混排往返无损', () => {
    const { bridge } = createBridge()
    const text = '云溪 拔剑，cold light 闪过——第 12 章'
    bridge.setDraft(text)
    expect(bridge.draft.value).toBe(text)
  })
})

describe('useComposerBridge 光标映射', () => {
  it('段内与跨段偏移双向映射', () => {
    const { bridge } = createBridge()
    bridge.setDraft('hello\nworld')
    for (const offset of [0, 3, 5, 6, 8, 11]) {
      bridge.setCaretOffset(offset)
      expect(bridge.caretOffset()).toBe(offset)
    }
  })

  it('偏移落在段间换行上时折算为前段末尾（边界取前）', () => {
    const { bridge } = createBridge()
    bridge.setDraft('hello\nworld')
    bridge.setCaretOffset(5)
    expect(bridge.caretOffset()).toBe(5)
  })

  it('超界偏移钳制到末尾', () => {
    const { bridge } = createBridge()
    bridge.setDraft('abc')
    bridge.setCaretOffset(99)
    expect(bridge.caretOffset()).toBe(3)
  })
})

describe('useComposerBridge insertAtCaret', () => {
  it('在光标处插入并后移光标', () => {
    const { bridge } = createBridge()
    bridge.setDraft('abcdef')
    bridge.setCaretOffset(3)
    bridge.insertAtCaret('XY')
    expect(bridge.draft.value).toBe('abcXYdef')
    expect(bridge.caretOffset()).toBe(5)
  })

  it('无选区时回退到末尾插入（ghost 采纳场景）', () => {
    const { bridge } = createBridge()
    bridge.setDraft('开头')
    bridge.editor.update(
      () => {
        $setSelection(null)
      },
      { discrete: true },
    )
    expect(bridge.caretOffset()).toBeNull()
    bridge.insertAtCaret('继续')
    expect(bridge.draft.value).toBe('开头继续')
    expect(bridge.caretOffset()).toBe(4)
  })

  it('插入含换行的文本产生新段落', () => {
    const { bridge } = createBridge()
    bridge.setDraft('aa\nbb')
    bridge.setCaretOffset(2)
    bridge.insertAtCaret('x\ny')
    expect(bridge.draft.value).toBe('aax\ny\nbb')
    expect(bridge.caretOffset()).toBe(5)
  })
})

describe('useComposerBridge replaceTokenBeforeCaret', () => {
  it('替换行首斜杠 token：边界空白不存在时直接替换', () => {
    const { bridge } = createBridge()
    bridge.setDraft('/整理')
    const replaced = bridge.replaceTokenBeforeCaret(SLASH_COMMAND_RE, '/管理要素 ')
    expect(replaced).toBe(true)
    expect(bridge.draft.value).toBe('/管理要素 ')
    expect(bridge.caretOffset()).toBe('/管理要素 '.length)
  })

  it('替换保留 token 前的边界空白', () => {
    const { bridge } = createBridge()
    bridge.setDraft('写完这章 /整理')
    bridge.replaceTokenBeforeCaret(SLASH_COMMAND_RE, '/管理要素 ')
    expect(bridge.draft.value).toBe('写完这章 /管理要素 ')
  })

  it('替换后光标之后的内容原样保留（token 后原空格保留，替换文本尾空格叠加）', () => {
    const { bridge } = createBridge()
    bridge.setDraft('/整理 这后面的参数')
    bridge.setCaretOffset(3)
    bridge.replaceTokenBeforeCaret(SLASH_COMMAND_RE, '/管理要素 ')
    // 与旧 replaceTokenAtCursor 行为一致：替换文本自带尾空格 + afterCursor 原有的空格
    expect(bridge.draft.value).toBe('/管理要素  这后面的参数')
  })

  it('@token 清除（选中大纲场景：替换为空）', () => {
    const { bridge } = createBridge()
    bridge.setDraft('正文 @主')
    bridge.replaceTokenBeforeCaret(OUTLINE_COMMAND_RE)
    expect(bridge.draft.value).toBe('正文 ')
    expect(bridge.caretOffset()).toBe(3)
  })

  it('无匹配返回 false 且草稿不变', () => {
    const { bridge } = createBridge()
    bridge.setDraft('普通文本')
    expect(bridge.replaceTokenBeforeCaret(SLASH_COMMAND_RE, '/管理要素 ')).toBe(false)
    expect(bridge.draft.value).toBe('普通文本')
  })
})
