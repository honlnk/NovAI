import { describe, expect, it } from 'vitest'

import type { ChatMessageView, ToolNameView } from '@novai/core/services/types'

import { buildRenderItems } from './chat-render'

/**
 * 渲染序列预处理（文档 3 S4）测试：
 * 工具行按 toolCallId 配对、旧数据无字段独立成行、任务组折叠、steering 不是组边界、
 * 白名单永不折叠、纯问答轮不出折叠行、运行中最后一轮不折叠。
 */

function userMessage(id: string, text: string, steered = false): ChatMessageView {
  return { id, role: 'user', kind: 'text', text, ...(steered ? { steered } : {}), createdAt: '2026-09-19T00:00:00.000Z' }
}

function assistantMessage(id: string, text: string): ChatMessageView {
  return { id, role: 'assistant', kind: 'text', text, createdAt: '2026-09-19T00:00:00.000Z' }
}

function toolCall(id: string, callId: string | undefined, name: ToolNameView = 'EditFile'): ChatMessageView {
  return {
    id,
    role: 'system',
    kind: 'tool-call',
    text: '参数摘要',
    toolName: name,
    ...(callId ? { toolCallId: callId } : {}),
    createdAt: '2026-09-19T00:00:00.000Z',
  }
}

function toolResult(id: string, callId: string | undefined, ok = true): ChatMessageView {
  return {
    id,
    role: 'system',
    kind: 'tool-result',
    text: ok ? '已处理' : '失败：文件不存在',
    ok,
    toolName: 'EditFile',
    ...(callId ? { toolCallId: callId } : {}),
    createdAt: '2026-09-19T00:00:00.000Z',
  }
}

function contextSummary(id: string): ChatMessageView {
  return { id, role: 'system', kind: 'context-summary', text: '本轮目标', createdAt: '2026-09-19T00:00:00.000Z' }
}

function changeSummary(id: string): ChatMessageView {
  return {
    id,
    role: 'system',
    kind: 'change-summary',
    runId: 'run-1',
    changes: [],
    createdAt: '2026-09-19T00:00:00.000Z',
  }
}

/** 深度收集全部工具行（含折叠组内） */
function collectToolRows(items: ReturnType<typeof buildRenderItems>) {
  const rows: Array<ReturnType<typeof buildRenderItems>[number] & { kind: 'tool-row' }> = []
  for (const item of items) {
    if (item.kind === 'tool-row') {
      rows.push(item)
    } else if (item.kind === 'process-group') {
      rows.push(...collectToolRows(item.items).filter((row) => row.kind === 'tool-row'))
    }
  }
  return rows
}

describe('buildRenderItems 工具行配对', () => {
  it('tool-call/tool-result 按 toolCallId 配成单行', () => {
    const items = buildRenderItems([
      userMessage('u1', '写第一章'),
      toolCall('c1', 'call-1'),
      toolResult('r1', 'call-1'),
    ], { running: false })

    const rows = collectToolRows(items)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row.kind !== 'tool-row') throw new Error('unreachable')
    expect(row.id).toBe('c1')
    expect(row.call?.id).toBe('c1')
    expect(row.result?.id).toBe('r1')
  })

  it('旧会话消息无 toolCallId：各自独立成行，不报错', () => {
    const items = buildRenderItems([
      userMessage('u1', '写第一章'),
      toolCall('c1', undefined),
      toolResult('r1', undefined),
    ], { running: false })

    const rows = collectToolRows(items)
    expect(rows).toHaveLength(2)
    const [orphanCall, orphanResult] = rows
    if (orphanCall.kind !== 'tool-row' || orphanResult.kind !== 'tool-row') throw new Error('unreachable')
    expect(orphanCall.call?.id).toBe('c1')
    expect(orphanCall.result).toBeUndefined()
    expect(orphanResult.result?.id).toBe('r1')
    expect(orphanResult.call).toBeUndefined()
  })

  it('只有 call 没有 result：行保留，供 UI 显示转圈', () => {
    const items = buildRenderItems([
      userMessage('u1', '写第一章'),
      toolCall('c1', 'call-1'),
    ], { running: true })

    const row = collectToolRows(items)[0]
    if (!row) throw new Error('unreachable')
    expect(row.call?.id).toBe('c1')
    expect(row.result).toBeUndefined()
  })
})

describe('buildRenderItems 任务组折叠', () => {
  it('一轮任务的过程消息（context-summary/工具行/中间 assistant）折叠成组，白名单成员保持原位', () => {
    const items = buildRenderItems([
      userMessage('u1', '写第一章'),
      contextSummary('s1'),
      toolCall('c1', 'call-1'),
      toolResult('r1', 'call-1'),
      assistantMessage('a1', '中间思考'),
      assistantMessage('a2', '最终回答'),
      changeSummary('sum1'),
    ], { running: false })

    expect(items.map((item) => item.kind)).toEqual(['message', 'process-group', 'message', 'message'])
    const group = items[1]
    if (group.kind !== 'process-group') throw new Error('unreachable')
    expect(group.id).toBe('u1')
    expect(group.collapsed).toBe(true)
    expect(group.toolCallCount).toBe(1)
    expect(group.messageCount).toBe(3) // context-summary + 工具行 + 中间 assistant
    // 白名单：最终回答与 change-summary 不进组
    expect(group.items.some((item) => item.kind === 'message' && item.message.id === 'a2')).toBe(false)
    expect(group.items.some((item) => item.kind === 'message' && item.message.id === 'sum1')).toBe(false)
  })

  it('steering 消息不是组边界：作为组内常显成员', () => {
    const items = buildRenderItems([
      userMessage('u1', '写第一章'),
      toolCall('c1', 'call-1'),
      toolResult('r1', 'call-1'),
      userMessage('u2', '改成第三人称', true),
      assistantMessage('a1', '最终回答'),
    ], { running: false })

    // 只有一个组（u2 没开新组）；steering 消息在组外保持原位（常显）
    const groups = items.filter((item) => item.kind === 'process-group')
    expect(groups).toHaveLength(1)
    if (groups[0].kind !== 'process-group') throw new Error('unreachable')
    expect(groups[0].id).toBe('u1')
    const steeredMessage = items.find((item) => item.kind === 'message' && item.message.id === 'u2')
    expect(steeredMessage).toBeDefined()
  })

  it('纯问答轮不出折叠行', () => {
    const items = buildRenderItems([
      userMessage('u1', '主角叫什么'),
      assistantMessage('a1', '叫林安'),
    ], { running: false })

    expect(items.filter((item) => item.kind === 'process-group')).toHaveLength(0)
    expect(items.map((item) => item.kind)).toEqual(['message', 'message'])
  })

  it('运行中的最后一轮默认展开，历史轮默认收起；用户显式覆盖优先', () => {
    const messages = [
      userMessage('u1', '写第一章'),
      toolCall('c1', 'call-1'),
      toolResult('r1', 'call-1'),
      assistantMessage('a1', '完成'),
      userMessage('u2', '写第二章'),
      toolCall('c2', 'call-2'),
    ]

    const running = buildRenderItems(messages, { running: true })
    const groups = running.filter((item) => item.kind === 'process-group')
    expect(groups.map((g) => (g.kind === 'process-group' ? g.collapsed : null))).toEqual([true, false])

    const finished = buildRenderItems(messages, { running: false })
    const finishedGroups = finished.filter((item) => item.kind === 'process-group')
    expect(finishedGroups.every((g) => g.kind === 'process-group' && g.collapsed)).toBe(true)

    const overridden = buildRenderItems(messages, {
      running: false,
      expandedOverrides: new Map([['u1', true]]),
    })
    const firstGroup = overridden.find((item) => item.kind === 'process-group')
    expect(firstGroup?.kind === 'process-group' && firstGroup.collapsed).toBe(false)
  })

  it('首条 user 之前的残留消息原样置顶，不进组', () => {
    const items = buildRenderItems([
      contextSummary('s0'),
      userMessage('u1', '写第一章'),
      toolCall('c1', 'call-1'),
      toolResult('r1', 'call-1'),
    ], { running: false })

    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'process-group'])
    const group = items[2]
    if (group.kind !== 'process-group') throw new Error('unreachable')
    expect(group.items.every((item) => item.kind === 'tool-row')).toBe(true)
  })
})
