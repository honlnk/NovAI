import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentCompletion } from '../../agent/llm'
import { createAskUserQuestionTool } from '../../agent/ask-user-question'
import type { AgentMessage, AgentToolSchema } from '../../agent/messages'

/**
 * AskUserQuestion 四协议回归（计划第三阶段）：工具定义序列化、线上工具调用解析、
 * 作答后的历史回传三段在各协议线格式下保持配对。全部走协议夹具（fetch 假端点），
 * 不打真实供应商——未覆盖的真实端点在计划施工日志中列明。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** 真实工具的 schema（不手抄，随工具演进自动跟随） */
const askTool = createAskUserQuestionTool({})
const askToolSchema: AgentToolSchema = askTool.schema

/** 模型侧提问入参：多选剧情分叉（经各协议线格式往返） */
const questionInput = {
  question: '第三章的高潮冲突放在哪里？',
  header: '剧情方向',
  options: [
    { label: '码头对峙', description: '节奏最快' },
    { label: '书房摊牌', description: '情感更浓' },
  ],
  multiSelect: true,
}
const questionArguments = JSON.stringify(questionInput)

/** 用户作答经工具 formatResult 生成的回灌文本（多选完整集合 + 补充说明） */
const answerContent = askTool.formatResult({
  selectedLabels: ['码头对峙', '书房摊牌'],
  text: '结尾停在雨停',
  outcome: 'answered',
})

/** 作答后的完整历史：user → assistant(工具调用) → tool(答案) */
const answeredHistory: AgentMessage[] = [
  { role: 'user', content: '写第三章' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_ask_1', name: 'AskUserQuestion', input: questionInput }],
  },
  { role: 'tool', toolCallId: 'call_ask_1', name: 'AskUserQuestion', content: answerContent },
]

describe('AskUserQuestion 协议回归（openai / openai-responses / anthropic / gemini）', () => {
  it('openai-chat：tools 直传、流式 tool_calls 解析、role:tool 历史回传', async () => {
    const fetchMock = vi.fn()
      // 第一轮：模型发起提问（流式 tool_calls）
      .mockResolvedValueOnce(createSseStream([
        {
          choices: [{
            delta: {
              content: '第三章有一个剧情分叉需要你定。',
              tool_calls: [{
                index: 0,
                id: 'call_ask_1',
                type: 'function',
                function: { name: 'AskUserQuestion', arguments: questionArguments },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]))
      // 第二轮：作答回传后的下一拍（普通收尾）
      .mockResolvedValueOnce(createSseStream([
        { choices: [{ delta: { content: '好，按码头对峙推进，结尾落在雨停。' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))

    globalThis.fetch = fetchMock

    const askResult = await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '写第三章' }],
      tools: [askToolSchema],
    }, () => {})
    expect(askResult.finishReason).toBe('tool_calls')
    expect(askResult.toolCalls).toEqual([
      { id: 'call_ask_1', name: 'AskUserQuestion', input: questionInput },
    ])
    // 工具定义直传（openai 系线格式与 AgentToolSchema 同构）
    const askBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(askBody.tools).toEqual([askToolSchema])

    await streamAgentCompletion({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-chat',
      messages: answeredHistory,
      tools: [askToolSchema],
    }, () => {})

    const replayBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolTurn = replayBody.messages.find((m: { role: string }) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    expect(toolTurn.tool_calls[0]).toMatchObject({
      id: 'call_ask_1',
      type: 'function',
      function: { name: 'AskUserQuestion', arguments: questionArguments },
    })
    const resultMessage = replayBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(resultMessage).toMatchObject({
      tool_call_id: 'call_ask_1',
      name: 'AskUserQuestion',
      content: answerContent,
    })
  })

  it('openai-responses：工具扁平化、output_item.done 收集、function_call_output 回传', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createSseStream([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_ask_1', name: 'AskUserQuestion' } },
        { type: 'response.function_call_arguments.delta', delta: '{"question"' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_ask_1', name: 'AskUserQuestion', arguments: questionArguments },
        },
        {
          type: 'response.completed',
          response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_ask_1', name: 'AskUserQuestion' }] },
        },
      ]))
      .mockResolvedValueOnce(createSseStream([
        { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message' }] } },
      ]))

    globalThis.fetch = fetchMock

    const askResult = await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: '写第三章' }],
      tools: [askToolSchema],
    }, () => {})
    expect(askResult.finishReason).toBe('tool_calls')
    expect(askResult.toolCalls).toEqual([
      { id: 'call_ask_1', name: 'AskUserQuestion', input: questionInput },
    ])
    // 工具定义扁平化为 responses 形态（type/name/description/parameters 平铺）
    const askBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(askBody.tools).toEqual([{
      type: 'function',
      name: 'AskUserQuestion',
      description: askToolSchema.function.description,
      parameters: askToolSchema.function.parameters,
    }])

    await streamAgentCompletion({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.1',
      messages: answeredHistory,
      tools: [askToolSchema],
    }, () => {})

    const replayBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(replayBody.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_ask_1',
      name: 'AskUserQuestion',
      arguments: questionArguments,
    })
    expect(replayBody.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_ask_1',
      output: answerContent,
    })
  })

  it('anthropic：input_schema 形态、tool_use 流式块解析、tool_result 回传', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createSseStream([
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第三章有一个分叉需要你决定。' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_ask_1', name: 'AskUserQuestion', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: questionArguments } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]))
      .mockResolvedValueOnce(createSseStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好，按码头对峙推进。' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]))

    globalThis.fetch = fetchMock

    const askResult = await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: '写第三章' }],
      tools: [askToolSchema],
    }, () => {})
    expect(askResult.finishReason).toBe('tool_calls')
    expect(askResult.toolCalls).toEqual([
      { id: 'call_ask_1', name: 'AskUserQuestion', input: questionInput },
    ])
    // 工具定义映射为 anthropic 形态（parameters → input_schema）
    const askBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(askBody.tools).toEqual([{
      name: 'AskUserQuestion',
      description: askToolSchema.function.description,
      input_schema: askToolSchema.function.parameters,
    }])

    await streamAgentCompletion({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      messages: answeredHistory,
      tools: [askToolSchema],
    }, () => {})

    const replayBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const assistantTurn = replayBody.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistantTurn.content).toContainEqual({
      type: 'tool_use',
      id: 'call_ask_1',
      name: 'AskUserQuestion',
      input: questionInput,
    })
    const resultTurn = replayBody.messages.find(
      (m: { role: string; content: Array<{ type: string }> }) =>
        m.role === 'user' && m.content?.[0]?.type === 'tool_result',
    )
    expect(resultTurn.content).toContainEqual({
      type: 'tool_result',
      tool_use_id: 'call_ask_1',
      content: answerContent,
    })
  })

  it('gemini：functionDeclarations 净化 schema、functionCall 收集、functionResponse 回传', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createSseStream([
        {
          candidates: [{
            content: { role: 'model', parts: [{ text: '第三章有一个分叉需要你决定。' }] },
          }],
        },
        {
          candidates: [{
            content: { role: 'model', parts: [{ functionCall: { name: 'AskUserQuestion', args: questionInput } }] },
            finishReason: 'STOP',
          }],
        },
      ]))
      .mockResolvedValueOnce(createSseStream([
        {
          candidates: [{
            content: { role: 'model', parts: [{ text: '好，按码头对峙推进。' }] },
            finishReason: 'STOP',
          }],
        },
      ]))

    globalThis.fetch = fetchMock

    const askResult = await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '写第三章' }],
      tools: [askToolSchema],
    }, () => {})
    expect(askResult.finishReason).toBe('tool_calls')
    // gemini 线上无调用 id，适配器本地生成
    expect(askResult.toolCalls).toEqual([
      { id: expect.stringMatching(/^tool_call_/), name: 'AskUserQuestion', input: questionInput },
    ])
    // 工具定义映射 functionDeclarations，schema 净化剥掉 gemini 不接受的 additionalProperties（含嵌套）
    const askBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(askBody.tools).toHaveLength(1)
    const declaration = askBody.tools[0].functionDeclarations[0]
    expect(declaration.name).toBe('AskUserQuestion')
    expect(declaration.description).toBe(askToolSchema.function.description)
    expect(declaration.parameters).not.toHaveProperty('additionalProperties')
    expect(declaration.parameters.properties.options.items).not.toHaveProperty('additionalProperties')
    expect(declaration.parameters.properties.options.items.required).toEqual(['label'])

    await streamAgentCompletion({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      messages: answeredHistory,
      tools: [askToolSchema],
    }, () => {})

    const replayBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const modelTurn = replayBody.contents.find((c: { role: string }) => c.role === 'model')
    expect(modelTurn.parts).toContainEqual({ functionCall: { name: 'AskUserQuestion', args: questionInput } })
    const resultTurn = replayBody.contents.find(
      (c: { role: string; parts: Array<{ functionResponse?: unknown }> }) =>
        c.role === 'user' && c.parts.some((part) => 'functionResponse' in part),
    )
    expect(resultTurn.parts).toContainEqual({
      functionResponse: { name: 'AskUserQuestion', response: { result: answerContent } },
    })
  })
})

function createSseStream(payloads: unknown[]) {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('') + 'data: [DONE]\n\n'

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
