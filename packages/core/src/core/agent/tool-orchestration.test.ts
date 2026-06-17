import { describe, expect, it, vi } from 'vitest'

import { runAgentTools } from './tool-orchestration'
import type { AgentRunnableTool, AgentRunnableToolMap } from './tools'
import type { AgentToolCall } from './messages'
import type { ProjectSnapshot } from '../../types/project'

const stubProject = { handle: {} } as unknown as ProjectSnapshot

function createStubTool(name: string): AgentRunnableTool {
  return {
    name: name as AgentRunnableTool['name'],
    isReadOnly: true,
    isConcurrencySafe: true,
    schema: {
      type: 'function',
      function: { name, description: '', parameters: { type: 'object', properties: {} } },
    },
    core: {
      name: name as AgentRunnableTool['name'],
      validateInput: (input: unknown) => input,
      // 故意做成异步，模拟工具执行耗时
      run: vi.fn().mockResolvedValue({ ok: true }),
      summarizeInput: () => `调用 ${name}`,
      summarizeOutput: () => `${name} 执行完成`,
    },
    formatResult: () => `${name} 结果`,
  }
}

function createCall(name: string, index: number): AgentToolCall {
  return {
    id: `call_${index}`,
    name: name as AgentToolCall['name'],
    input: {},
  }
}

describe('runAgentTools', () => {
  it('executes all calls in order when the signal is not aborted', async () => {
    const toolA = createStubTool('ReadFile')
    const toolB = createStubTool('ListDirectory')
    const tools = { ReadFile: toolA, ListDirectory: toolB } as unknown as AgentRunnableToolMap

    const results = await runAgentTools({
      calls: [createCall('ReadFile', 1), createCall('ListDirectory', 2)],
      project: stubProject,
      tools,
    })

    expect(results).toHaveLength(2)
    expect(toolA.core.run).toHaveBeenCalledTimes(1)
    expect(toolB.core.run).toHaveBeenCalledTimes(1)
  })

  it('skips remaining tools in a batch once the user signal aborts', async () => {
    const controller = new AbortController()
    const toolA = createStubTool('ReadFile')
    // 第一个工具执行完后触发停止
    toolA.core.run = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { ok: true }
    })
    const toolB = createStubTool('ListDirectory')
    const toolC = createStubTool('FindFiles')
    const tools = {
      ReadFile: toolA,
      ListDirectory: toolB,
      FindFiles: toolC,
    } as unknown as AgentRunnableToolMap

    const results = await runAgentTools({
      calls: [
        createCall('ReadFile', 1),
        createCall('ListDirectory', 2),
        createCall('FindFiles', 3),
      ],
      project: stubProject,
      tools,
      signal: controller.signal,
    })

    // 第一个工具已执行；后两个被跳过，但仍补了 tool result 保证消息序列合法
    expect(results).toHaveLength(3)
    expect(toolA.core.run).toHaveBeenCalledTimes(1)
    expect(toolB.core.run).not.toHaveBeenCalled()
    expect(toolC.core.run).not.toHaveBeenCalled()

    // 被跳过的工具 result 内容表明已被跳过
    expect(results[1].content).toContain('跳过')
    expect(results[2].content).toContain('跳过')
    // toolCallId 仍对应原调用，保证对模型合法
    expect(results[1].toolCallId).toBe('call_2')
    expect(results[2].toolCallId).toBe('call_3')
  })

  it('does not skip when no signal is provided', async () => {
    const toolA = createStubTool('ReadFile')
    const toolB = createStubTool('ListDirectory')
    const tools = { ReadFile: toolA, ListDirectory: toolB } as unknown as AgentRunnableToolMap

    const results = await runAgentTools({
      calls: [createCall('ReadFile', 1), createCall('ListDirectory', 2)],
      project: stubProject,
      tools,
    })

    expect(results).toHaveLength(2)
    expect(toolA.core.run).toHaveBeenCalledTimes(1)
    expect(toolB.core.run).toHaveBeenCalledTimes(1)
  })
})
