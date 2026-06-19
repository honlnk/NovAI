import { describe, expect, it, vi } from 'vitest'

import { executeAgentTool } from './tool-execution'
import type { AgentRunnableTool } from './tools'
import type { AgentToolCall } from './messages'
import type { ProjectSnapshot } from '../../types/project'

const stubProject = { handle: {} } as unknown as ProjectSnapshot

function createCall(name: string, input: Record<string, unknown> = {}): AgentToolCall {
  return {
    id: `call_${name}`,
    name: name as AgentToolCall['name'],
    input,
  }
}

function createStubTool(options: {
  name: string
  run?: (input: unknown) => Promise<unknown>
  extractFileChange?: (output: unknown) => unknown
}): AgentRunnableTool {
  return {
    name: options.name as AgentRunnableTool['name'],
    isReadOnly: false,
    isConcurrencySafe: false,
    schema: {
      type: 'function',
      function: { name: options.name, description: '', parameters: { type: 'object', properties: {} } },
    },
    core: {
      name: options.name as AgentRunnableTool['name'],
      validateInput: (input: unknown) => input,
      run: options.run ?? vi.fn().mockResolvedValue({}),
      summarizeInput: () => `调用 ${options.name}`,
      summarizeOutput: () => `${options.name} 执行完成`,
      extractFileChange: options.extractFileChange as never,
    },
    formatResult: () => `${options.name} 结果`,
  }
}

describe('executeAgentTool', () => {
  it('attaches fileChange when the tool declares one on success', async () => {
    const tool = createStubTool({
      name: 'CreateFile',
      run: async () => ({ path: 'chapters/new.txt' }),
      extractFileChange: (output) => ({ type: 'created', path: (output as { path: string }).path }),
    })
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('CreateFile', { path: 'chapters/new.txt' }),
      project: stubProject,
      tools,
    })

    expect(result.fileChange).toEqual({ type: 'created', path: 'chapters/new.txt' })
  })

  it('leaves fileChange undefined for read-only tools without extractFileChange', async () => {
    const tool = createStubTool({
      name: 'ReadFile',
      run: async () => ({ path: 'chapters/001.txt', content: '内容' }),
    })
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
    })

    expect(result.fileChange).toBeUndefined()
  })

  it('leaves fileChange undefined when the tool throws', async () => {
    const tool = createStubTool({
      name: 'EditFile',
      run: async () => {
        throw new Error('文件已发生变化')
      },
      extractFileChange: (output) => ({ type: 'updated', path: (output as { path: string }).path }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('EditFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
    })

    expect(result.fileChange).toBeUndefined()
    expect(result.content).toContain('文件已发生变化')
  })
})
