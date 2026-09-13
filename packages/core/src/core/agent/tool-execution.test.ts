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
  isReadOnly?: boolean
  run?: (input: unknown) => Promise<unknown>
  extractFileChange?: (output: unknown) => unknown
  buildConfirmation?: (input: unknown) => unknown
}): AgentRunnableTool {
  return {
    name: options.name as AgentRunnableTool['name'],
    isReadOnly: options.isReadOnly ?? false,
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
      buildConfirmation: options.buildConfirmation as never,
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
      isReadOnly: true,
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

describe('executeAgentTool 范围权限与确认', () => {
  it('项目工作区内写入静默放行：不弹确认直接执行', async () => {
    const run = vi.fn().mockResolvedValue({ path: 'chapters/new.txt' })
    const tool = createStubTool({
      name: 'CreateFile',
      run,
      buildConfirmation: (input) => ({ kind: 'create', path: (input as { path: string }).path, content: (input as { content: string }).content }),
    })
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>
    const confirm = vi.fn().mockResolvedValue({ accepted: true })

    const result = await executeAgentTool({
      call: createCall('CreateFile', { path: 'chapters/new.txt', content: '内容' }),
      project: stubProject,
      tools,
      confirm,
    })

    // 确认疲劳消失：工作区内不再确认
    expect(confirm).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('CreateFile 结果')
  })

  it('越界路径弹一次确认，用户接受后执行', async () => {
    const run = vi.fn().mockResolvedValue({})
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>
    const confirm = vi.fn().mockResolvedValue({ accepted: true })

    await executeAgentTool({
      call: createCall('EditFile', { path: '../项目外/敏感.md' }),
      project: stubProject,
      tools,
      confirm,
    })

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('越界路径用户未授权则跳过执行，结果回灌模型', async () => {
    const run = vi.fn().mockResolvedValue({})
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('EditFile', { path: '../项目外/敏感.md' }),
      project: stubProject,
      tools,
      confirm: async () => ({ accepted: false }),
    })

    // 未执行 run，文件不变
    expect(run).not.toHaveBeenCalled()
    expect(result.content).toContain('未授权')
    expect(result.fileChange).toBeUndefined()
  })

  it('does not trigger confirmation for read-only tools', async () => {
    const run = vi.fn().mockResolvedValue({ path: 'chapters/001.txt', content: '内容' })
    const tool = createStubTool({
      name: 'ReadFile',
      isReadOnly: true,
      run,
    })
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>
    const confirm = vi.fn().mockResolvedValue({ accepted: true })

    await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      confirm,
    })

    // 只读工具不触发确认
    expect(confirm).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('treats a confirmation error (e.g. user stop) as rejection', async () => {
    const run = vi.fn().mockResolvedValue({})
    const tool = createStubTool({
      name: 'DeleteFile',
      run,
      buildConfirmation: (input) => ({ kind: 'delete', path: (input as { path: string }).path }),
    })
    const tools = { DeleteFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('DeleteFile', { path: '../项目外/old.txt' }),
      project: stubProject,
      tools,
      confirm: async () => {
        throw new Error('aborted')
      },
    })

    // 确认中断按拒绝处理，不执行
    expect(run).not.toHaveBeenCalled()
    expect(result.content).toContain('未授权')
  })
})
