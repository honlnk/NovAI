import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMPACTED_SUMMARY_CLOSE,
  COMPACTED_SUMMARY_OPEN,
  SUMMARY_MAX_TOKENS,
  buildCompactionRequest,
  buildSummaryMessage,
  computeRetainTokens,
  isContextOverflowError,
  runCompaction,
  selectCompactionRange,
  shouldCompact,
  validateSummary,
} from './compaction'
import { streamAgentCompletion } from './llm'
import { createModelView, estimateMessagesTokens, estimateTextTokens, type ModelView } from './model-view'
import type { AgentMessage } from './messages'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>()
  return {
    ...actual,
    streamAgentCompletion: vi.fn(),
  }
})

const mockedStream = vi.mocked(streamAgentCompletion)

const stubConfig = {
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: { enableDebugLogging: false, conversationTokenLimit: 12000, compressionKeepRecentTurns: 5 },
} as unknown as ProjectConfig

const stubProject = { handle: {} } as unknown as ProjectSnapshot

/** 构造 [system, ...turns] 视图；每条正文默认 10 个中文字符（≈10 token） */
function createViewWithTurns(turnTexts: string[], options: { longText?: string } = {}): ModelView {
  const messages: AgentMessage[] = [{ role: 'system', content: '系统提示' }]
  turnTexts.forEach((text, index) => {
    const long = options.longText && index === turnTexts.length - 1 ? options.longText : text
    messages.push(index % 2 === 0
      ? { role: 'user', content: long }
      : { role: 'assistant', content: long })
  })
  return createModelView(messages)
}

describe('shouldCompact', () => {
  it('达到阈值返回 true，未达到返回 false', () => {
    const small = createModelView([{ role: 'user', content: '短' }])
    const big = createModelView([{ role: 'user', content: '长'.repeat(500) }])

    expect(shouldCompact(small, 100)).toBe(false)
    expect(shouldCompact(big, 100)).toBe(true)
  })
})

describe('selectCompactionRange', () => {
  it('system 提示（index 0）永不进压缩区：startIdx 恒为 1', () => {
    const view = createViewWithTurns(['一'.repeat(40), '二'.repeat(40), '三'.repeat(40), '四'.repeat(40)])

    const range = selectCompactionRange(view, 10)!

    expect(range).not.toBeNull()
    expect(range.startIdx).toBe(1)
  })

  it('保留尾部 retainTokens 的原文，其前为压缩区', () => {
    const view = createViewWithTurns(Array.from({ length: 10 }, (_, i) => `${i}`.padStart(10, '一')))

    const range = selectCompactionRange(view, 35)!

    // 每条消息 ≈ 10 token + 4 开销；保留约 35 token ≈ 最后 2-3 条，压缩区约 [1..7]
    expect(range.endIdx).toBeGreaterThanOrEqual(5)
    expect(range.endIdx).toBeLessThanOrEqual(8)
    const originalTokens = estimateMessagesTokens(view.messages.slice(range.startIdx, range.endIdx + 1))
    const retainedTokens = estimateMessagesTokens(view.messages.slice(range.endIdx + 1))
    expect(retainedTokens).toBeGreaterThanOrEqual(35 - 20)
    expect(originalTokens).toBeGreaterThan(0)
  })

  it('工具配对回退：切线切开 assistant(toolCalls) ↔ tool 结果时边界前移', () => {
    // system, user, assistant(call), tool(result), user, assistant —— retain 只容下最后 1 条时，
    // 原始切线会落在 tool 与 user 之间（tool 被保留）或 assistant(call) 与 tool 之间。
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '一'.repeat(200) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'ReadFile', input: { path: 'a' } }] },
      { role: 'tool', toolCallId: 'call_1', name: 'ReadFile', content: '一'.repeat(200) },
      { role: 'user', content: '二'.repeat(200) },
      { role: 'assistant', content: '回'.repeat(200) },
    ])

    // retain 很小：保留区起点最先落在 tool 结果上（其 call 在更前面）
    const range = selectCompactionRange(view, 5)!

    expect(range).not.toBeNull()
    // 回退后：保留区第一条消息不能是 tool（悬空结果），也不能切开 call 与 result
    expect(view.messages[range.endIdx + 1].role).not.toBe('tool')
    // 压缩区末尾若是 assistant(toolCalls)，其 tool 结果必须也在压缩区（否则悬空）
    const lastCompressed = view.messages[range.endIdx]
    if (lastCompressed.role === 'assistant' && lastCompressed.toolCalls?.length) {
      expect(view.messages[range.endIdx + 1].role).not.toBe('tool')
    }
  })

  it('保留区已盖到系统头（无可压区间）时返回 null', () => {
    const view = createViewWithTurns(['一'.repeat(500), '二'.repeat(500)])

    expect(selectCompactionRange(view, 100000)).toBeNull()
  })

  it('消息不足（只有 system + 1 条）时返回 null', () => {
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '唯一一条' },
    ])

    expect(selectCompactionRange(view, 0)).toBeNull()
  })

  it('index 0 不是 system（异常视图）时返回 null', () => {
    const view = createModelView([
      { role: 'user', content: '首条异常' },
      { role: 'assistant', content: '回复' },
    ])

    expect(selectCompactionRange(view, 0)).toBeNull()
  })
})

describe('computeRetainTokens', () => {
  it('按阈值 16% 与最近 N 轮取并集', () => {
    const view = createViewWithTurns([
      '一'.repeat(100), '二'.repeat(100),
      '三'.repeat(100), '四'.repeat(100),
      '五'.repeat(100), '六'.repeat(100),
    ])

    const byRatio = Math.floor(10000 * 0.16)
    // keepRecentTurns = 1：保留最后一轮（user 五 + assistant 六 ≈ 208 token）
    expect(computeRetainTokens(view.messages, 10000, 1)).toBe(Math.max(byRatio, 208))
    // keepRecentTurns = 0：退化为纯比例
    expect(computeRetainTokens(view.messages, 10000, 0)).toBe(byRatio)
  })
})

describe('buildCompactionRequest', () => {
  it('系统提示在前、区间原文居中、压缩指令末尾（prefix cache 友好）', () => {
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: '被压一' },
      { role: 'assistant', content: '被压二' },
      { role: 'user', content: '保留一' },
    ])

    const request = buildCompactionRequest(view, { startIdx: 1, endIdx: 2 })

    expect(request).toHaveLength(4)
    expect(request[0]).toEqual({ role: 'system', content: '系统' })
    expect(request[1]).toEqual({ role: 'user', content: '被压一' })
    expect(request[2]).toEqual({ role: 'assistant', content: '被压二' })
    expect(request[3].role).toBe('user')
    expect(request[3].content).toContain('检查点')
  })
})

describe('validateSummary（收缩校验）', () => {
  it('空摘要不通过', () => {
    expect(validateSummary('', 100)).toBe(false)
    expect(validateSummary('   \n  ', 100)).toBe(false)
  })

  it('摘要不比原文小就不通过', () => {
    const longSummary = '摘'.repeat(200)
    expect(validateSummary(longSummary, 100)).toBe(false)
  })

  it('显著收缩的摘要通过', () => {
    expect(validateSummary('短摘要', 1000)).toBe(true)
  })
})

describe('buildSummaryMessage（自合并格式）', () => {
  it('是 user 消息，含 preamble 与 <compacted-summary> 包裹', () => {
    const message = buildSummaryMessage('摘要正文')

    expect(message.role).toBe('user')
    expect(message.content).toContain(COMPACTED_SUMMARY_OPEN)
    expect(message.content).toContain(COMPACTED_SUMMARY_CLOSE)
    expect(message.content).toContain('摘要正文')
    expect(message.content).toContain('既定背景')
  })
})

describe('runCompaction', () => {
  beforeEach(() => {
    mockedStream.mockReset()
  })

  it('成功流程：摘要替换被压区间，视图收缩', async () => {
    const view = createViewWithTurns(Array.from({ length: 12 }, () => '一'.repeat(100)))
    const tokensBefore = estimateTextTokens(view.messages.map((m) => m.content).join(''))

    mockedStream.mockResolvedValue({
      content: '## Primary Request and Intent\n写小说',
      toolCalls: [],
      finishReason: 'stop',
    })

    const result = await runCompaction({ config: stubConfig, view, retainTokens: 50 })

    expect(result).not.toBeNull()
    expect(result!.originalTokens).toBeGreaterThan(result!.summaryTokens)
    expect(view.messages[0].role).toBe('system') // system 不动
    expect(view.messages[1].content).toContain(COMPACTED_SUMMARY_OPEN) // 区间被摘要替换
    expect(view.messages.length).toBeLessThan(13)
    expect(estimateTextTokens(view.messages.map((m) => m.content).join(''))).toBeLessThan(tokensBefore)
    // 摘要调用不带 tools，且带输出上限（防 provider 默认不设防、配合 length 截断拒落地）
    expect(mockedStream.mock.calls[0][0].tools).toEqual([])
    expect(mockedStream.mock.calls[0][0].maxTokens).toBe(SUMMARY_MAX_TOKENS)
  })

  it('摘要比原文长时放弃，视图不变', async () => {
    const view = createViewWithTurns(['一'.repeat(20), '二'.repeat(20), '三'.repeat(20), '四'.repeat(20)])
    const before = [...view.messages]

    mockedStream.mockResolvedValue({
      content: '废'.repeat(500), // 比被压区间还长
      toolCalls: [],
      finishReason: 'stop',
    })

    const result = await runCompaction({ config: stubConfig, view, retainTokens: 5 })

    expect(result).toBeNull()
    expect(view.messages).toEqual(before)
  })

  it('摘要被 max-tokens 截断时放弃，视图不变', async () => {
    const view = createViewWithTurns(['一'.repeat(50), '二'.repeat(50), '三'.repeat(50), '四'.repeat(50)])
    const before = [...view.messages]

    mockedStream.mockResolvedValue({
      content: '看起来正常的摘要',
      toolCalls: [],
      finishReason: 'length', // 截断
    })

    const result = await runCompaction({ config: stubConfig, view, retainTokens: 5 })

    expect(result).toBeNull()
    expect(view.messages).toEqual(before)
  })

  it('摘要调用抛错时返回 null，视图不变（宁缺毋滥）', async () => {
    const view = createViewWithTurns(['一'.repeat(50), '二'.repeat(50), '三'.repeat(50), '四'.repeat(50)])
    const before = [...view.messages]

    mockedStream.mockRejectedValue(new Error('模型服务不可用'))

    const result = await runCompaction({ config: stubConfig, view, retainTokens: 5 })

    expect(result).toBeNull()
    expect(view.messages).toEqual(before)
  })

  it('多轮压缩：摘要请求包含旧 <compacted-summary> 时指令要求自合并（收敛规则在指令里）', async () => {
    // 已压缩过一轮的视图：区间位置是一条摘要消息
    const view = createModelView([
      { role: 'system', content: '系统' },
      { role: 'user', content: `${COMPACTED_SUMMARY_OPEN}\n旧检查点\n${COMPACTED_SUMMARY_CLOSE}` },
      { role: 'user', content: '新指令'.repeat(50) },
      { role: 'assistant', content: '回复'.repeat(50) },
    ])

    mockedStream.mockResolvedValue({ content: '新摘要', toolCalls: [], finishReason: 'stop' })

    const result = await runCompaction({ config: stubConfig, view, retainTokens: 5 })

    expect(result).not.toBeNull()
    // 发出的摘要请求里带着旧检查点原文与自合并指令
    const request = mockedStream.mock.calls[0][0].messages
    const instruction = request.at(-1)
    expect(instruction?.content).toContain(COMPACTED_SUMMARY_OPEN)
    expect(instruction?.content).toContain('合并')
    // 落地后仍是单一摘要（不会出现两个 <compacted-summary> 块）
    const summaryBlocks = view.messages.filter(
      (m) => m.role === 'user' && m.content.includes(COMPACTED_SUMMARY_OPEN),
    )
    expect(summaryBlocks).toHaveLength(1)
  })
})

describe('isContextOverflowError', () => {
  it('识别常见 context 超限错误文案', () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 8192 tokens"))).toBe(true)
    expect(isContextOverflowError(new Error('context_length_exceeded'))).toBe(true)
    expect(isContextOverflowError(new Error('prompt is too long: context window exceeded'))).toBe(true)
  })

  it('识别百炼（DashScope）溢出文案：Range of input length should be [1, xxx]', () => {
    expect(isContextOverflowError(new Error('Range of input length should be [1, 30720]'))).toBe(true)
    expect(isContextOverflowError(new Error('InternalError.Algo.InvalidParameter: Range of input length should be [1,131072]'))).toBe(true)
    expect(isContextOverflowError(new Error('input length exceeds the limit'))).toBe(true)
  })

  it('普通错误与未知类型不误判', () => {
    expect(isContextOverflowError(new Error('连接超时'))).toBe(false)
    expect(isContextOverflowError('字符串错误')).toBe(false)
    expect(isContextOverflowError(undefined)).toBe(false)
  })

  it('百炼 max_tokens 参数越界（输出上限问题）不误判为上下文溢出', () => {
    expect(isContextOverflowError(new Error('Range of max_tokens should be [1, 2048]'))).toBe(false)
  })
})
