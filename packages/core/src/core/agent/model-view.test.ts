import { describe, expect, it } from 'vitest'

import {
  appendAssistantMessage,
  appendToolResults,
  appendUserMessage,
  createModelView,
  estimateTextTokens,
  estimateTokens,
  replaceRangeWithSummary,
  setSystemMessage,
  toRequestMessages,
} from './model-view'
import type { AgentMessage } from './messages'

describe('ModelView 追加', () => {
  it('appendUser/appendAssistant/appendToolResults 按序累积消息', () => {
    const view = createModelView()

    appendUserMessage(view, '写一个开头')
    appendAssistantMessage(view, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'chapters/001.txt' } }],
    })
    appendToolResults(view, [
      { role: 'tool', toolCallId: 'call_1', name: 'ReadFile', content: '正文' },
    ])

    expect(view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('createModelView 拷贝传入数组，与外部互不影响', () => {
    const initial: AgentMessage[] = [{ role: 'user', content: '外部消息' }]
    const view = createModelView(initial)

    appendUserMessage(view, '后续')

    expect(initial).toHaveLength(1)
    expect(view.messages).toHaveLength(2)
  })
})

describe('setSystemMessage', () => {
  it('替换 index 0 的 system message，其余消息不动', () => {
    const view = createModelView([
      { role: 'system', content: '旧 system prompt' },
      { role: 'user', content: '用户第一条' },
      { role: 'assistant', content: '助手回复' },
    ])

    setSystemMessage(view, '新 system prompt')

    expect(view.messages[0]).toEqual({ role: 'system', content: '新 system prompt' })
    expect(view.messages[1]).toEqual({ role: 'user', content: '用户第一条' })
    expect(view.messages[2]).toEqual({ role: 'assistant', content: '助手回复' })
    expect(view.messages).toHaveLength(3)
  })

  it('空视图（首轮）时插入到头部', () => {
    const view = createModelView()

    setSystemMessage(view, '系统提示')
    appendUserMessage(view, '用户第一条')

    expect(view.messages[0]).toEqual({ role: 'system', content: '系统提示' })
    expect(view.messages[1]).toEqual({ role: 'user', content: '用户第一条' })
  })

  it('首条不是 system（异常）时插入头部而不是覆盖', () => {
    const view = createModelView([{ role: 'user', content: '首条是 user' }])

    setSystemMessage(view, '系统提示')

    expect(view.messages[0]).toEqual({ role: 'system', content: '系统提示' })
    expect(view.messages[1]).toEqual({ role: 'user', content: '首条是 user' })
  })

  it('替换后 assistant 的 toolCalls 结构完整保留', () => {
    const view = createModelView([
      { role: 'system', content: '旧' },
      { role: 'user', content: '读一下文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'ReadFile', content: '文件内容' },
    ])

    setSystemMessage(view, '新 system')

    expect(view.messages[0]).toEqual({ role: 'system', content: '新 system' })
    expect(view.messages[2].role).toBe('assistant')
    const assistant = view.messages[2]
    expect(assistant.role === 'assistant' && assistant.toolCalls).toHaveLength(1)
    expect(view.messages[3].role).toBe('tool')
  })
})

describe('replaceRangeWithSummary', () => {
  function createTurnView(): ReturnType<typeof createModelView> {
    return createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '回复一' },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: '回复二' },
    ])
  }

  it('把 [startIdx, endIdx] 区间替换为一条摘要消息', () => {
    const view = createTurnView()
    const summary: AgentMessage = { role: 'user', content: '<compacted-summary>摘要</compacted-summary>' }

    replaceRangeWithSummary(view, 1, 3, summary)

    expect(view.messages).toEqual([
      { role: 'system', content: '系统' },
      summary,
      { role: 'assistant', content: '回复二' },
    ])
  })

  it('区间非法时抛错（越界/倒置/非整数）', () => {
    const view = createTurnView()
    const summary: AgentMessage = { role: 'user', content: '摘要' }

    expect(() => replaceRangeWithSummary(view, -1, 2, summary)).toThrow()
    expect(() => replaceRangeWithSummary(view, 2, 1, summary)).toThrow()
    expect(() => replaceRangeWithSummary(view, 1, 99, summary)).toThrow()
    expect(() => replaceRangeWithSummary(view, 1.5, 2, summary)).toThrow()
    // 抛错不改变原视图
    expect(view.messages).toHaveLength(5)
  })
})

describe('toRequestMessages', () => {
  it('返回防御性拷贝，调用方改动不影响视图', () => {
    const view = createModelView([{ role: 'user', content: '原始' }])

    const request = toRequestMessages(view)
    request.push({ role: 'user', content: '调用方追加' })

    expect(view.messages).toHaveLength(1)
  })
})

describe('estimateTokens', () => {
  it('空视图为 0', () => {
    expect(estimateTokens(createModelView())).toBe(0)
  })

  it('中文按 1 字 1 token 估算，英文按 4 字符 1 token 估算', () => {
    // 4000 字中文章节 ≈ 4000 token 量级，而不是 chars/4 的 1000
    expect(estimateTextTokens('中'.repeat(4000))).toBe(4000)
    expect(estimateTextTokens('a'.repeat(400))).toBe(100)
    // 中英混排分治
    expect(estimateTextTokens('章节chapter')).toBe(2 + 2)
    // 全角标点按 CJK 计
    expect(estimateTextTokens('你好，世界。')).toBe(6)
  })

  it('包含每消息结构开销与 toolCalls 的参数开销', () => {
    const view = createModelView([
      { role: 'user', content: '中'.repeat(96) },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'a.txt' } }],
      },
    ])

    const tokens = estimateTokens(view)

    // user: 96 + 4 overhead；assistant: 4 overhead + toolCalls JSON 估算（>0）
    expect(tokens).toBeGreaterThan(96 + 4 + 4)
    expect(tokens).toBeLessThan(96 + 8 + 200)
  })
})
