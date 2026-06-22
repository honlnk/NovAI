import { describe, expect, it } from 'vitest'

import { refreshSystemMessageContent } from './session'
import type { AgentMessage } from '../agent/messages'

describe('refreshSystemMessageContent', () => {
  it('replaces the system message content at index 0', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: '旧 system prompt' },
      { role: 'user', content: '用户第一条' },
      { role: 'assistant', content: '助手回复' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system prompt')

    expect(result[0]).toEqual({ role: 'system', content: '新 system prompt' })
    // 后续消息原样保留
    expect(result[1]).toEqual({ role: 'user', content: '用户第一条' })
    expect(result[2]).toEqual({ role: 'assistant', content: '助手回复' })
    expect(result).toHaveLength(3)
  })

  it('does not mutate the original array (returns new array)', () => {
    const original: AgentMessage[] = [
      { role: 'system', content: '旧' },
      { role: 'user', content: '用户' },
    ]

    const result = refreshSystemMessageContent(original, '新')

    expect(original[0].content).toBe('旧') // 原数组不变
    expect(result).not.toBe(original) // 返回新数组
    expect(result[0].content).toBe('新')
  })

  it('returns messages as-is when index 0 is not a system message', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '首条不是 system' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system prompt')

    expect(result).toBe(messages)
  })

  it('returns empty array as-is', () => {
    expect(refreshSystemMessageContent([], '新')).toEqual([])
  })

  it('preserves tool-call assistant messages after the system message', () => {
    // 模拟真实 Agent Loop 产生的消息序列：system, user, assistant(toolCalls), tool(result)
    const messages: AgentMessage[] = [
      { role: 'system', content: '旧' },
      { role: 'user', content: '读一下文件' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'ReadFile', content: '文件内容' },
    ]

    const result = refreshSystemMessageContent(messages, '新 system')

    expect(result[0].content).toBe('新 system')
    // tool call / tool result 结构完整保留
    expect(result[2].role).toBe('assistant')
    expect(result[3].role).toBe('tool')
    expect((result[2] as { toolCalls?: unknown }).toolCalls).toHaveLength(1)
  })
})
