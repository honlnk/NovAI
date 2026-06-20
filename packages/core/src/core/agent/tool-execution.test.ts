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

describe('executeAgentTool confirmation', () => {
  it('executes the write tool after the user accepts confirmation', async () => {
    const run = vi.fn().mockResolvedValue({ path: 'chapters/new.txt' })
    const tool = createStubTool({
      name: 'CreateFile',
      run,
      buildConfirmation: (input) => ({ kind: 'create', path: (input as { path: string }).path, content: (input as { content: string }).content }),
    })
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('CreateFile', { path: 'chapters/new.txt', content: '内容' }),
      project: stubProject,
      tools,
      confirm: async () => ({ accepted: true }),
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('CreateFile 结果')
  })

  it('skips execution and returns a rejection result when the user rejects', async () => {
    const run = vi.fn().mockResolvedValue({})
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('EditFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      confirm: async () => ({ accepted: false }),
    })

    // 未执行 run，文件不变
    expect(run).not.toHaveBeenCalled()
    // 返回拒绝结果回灌模型，不含 fileChange
    expect(result.content).toContain('用户拒绝')
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
      call: createCall('DeleteFile', { path: 'chapters/old.txt' }),
      project: stubProject,
      tools,
      confirm: async () => {
        throw new Error('aborted')
      },
    })

    // 确认中断按拒绝处理，不执行
    expect(run).not.toHaveBeenCalled()
    expect(result.content).toContain('用户拒绝')
  })
})

describe('executeAgentTool toolPolicy', () => {
  it('rejects read tools when allowRead is false', async () => {
    const run = vi.fn().mockResolvedValue({ path: 'chapters/001.txt', content: '内容' })
    const tool = createStubTool({ name: 'ReadFile', isReadOnly: true, run })
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      toolPolicy: { allowRead: false, allowWrite: true },
    })

    expect(run).not.toHaveBeenCalled()
    expect(result.content).toContain('禁用')
    expect(result.content).toContain('读取')
    expect(result.fileChange).toBeUndefined()
  })

  it('rejects write tools when allowWrite is false', async () => {
    const run = vi.fn().mockResolvedValue({})
    const tool = createStubTool({
      name: 'CreateFile',
      run,
      buildConfirmation: (input) => ({ kind: 'create', path: (input as { path: string }).path, content: '' }),
    })
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('CreateFile', { path: 'chapters/new.txt' }),
      project: stubProject,
      tools,
      toolPolicy: { allowRead: true, allowWrite: false },
    })

    expect(run).not.toHaveBeenCalled()
    expect(result.content).toContain('禁用')
    expect(result.content).toContain('修改')
  })

  it('executes normally when policy allows the tool', async () => {
    const run = vi.fn().mockResolvedValue({ path: 'chapters/001.txt', content: '内容' })
    const tool = createStubTool({ name: 'ReadFile', isReadOnly: true, run })
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      toolPolicy: { allowRead: true, allowWrite: true },
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('ReadFile 结果')
  })

  it('policy denial takes precedence over confirmation (no confirm popup for disabled tools)', async () => {
    const run = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue({ accepted: true })
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    await executeAgentTool({
      call: createCall('EditFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      confirm,
      toolPolicy: { allowRead: true, allowWrite: false },
    })

    // 被禁工具直接拒绝，不弹确认
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('executeAgentTool path policy (allowedWritePath)', () => {
  it('blocks EditFile when its path differs from allowedWritePath', async () => {
    const run = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue({ accepted: true })
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('EditFile', { path: 'chapters/002.txt' }),
      project: stubProject,
      tools,
      confirm,
      toolPolicy: { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' },
    })

    // 写非当前文件被拒：不执行、不弹确认
    expect(run).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(result.content).toContain('chapters/001.txt')
    expect(result.fileChange).toBeUndefined()
  })

  it('allows EditFile through when its path matches allowedWritePath', async () => {
    const run = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue({ accepted: true })
    const tool = createStubTool({
      name: 'EditFile',
      run,
      buildConfirmation: (input) => ({ kind: 'edit', path: (input as { path: string }).path, oldText: 'a', newText: 'b' }),
    })
    const tools = { EditFile: tool } as unknown as Record<string, AgentRunnableTool>

    await executeAgentTool({
      call: createCall('EditFile', { path: 'chapters/001.txt' }),
      project: stubProject,
      tools,
      confirm,
      toolPolicy: { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' },
    })

    // 写当前文件放行（仍走确认流程）
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('always blocks RenameFile under path constraint', async () => {
    const run = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue({ accepted: true })
    const tool = createStubTool({
      name: 'RenameFile',
      run,
      buildConfirmation: (input) => ({ kind: 'rename', fromPath: (input as { fromPath: string }).fromPath, toPath: (input as { toPath: string }).toPath }),
    })
    const tools = { RenameFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('RenameFile', { fromPath: 'chapters/001.txt', toPath: 'chapters/002.txt' }),
      project: stubProject,
      tools,
      confirm,
      toolPolicy: { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' },
    })

    // 即便 fromPath 是当前文件，RenameFile 仍被禁
    expect(run).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(result.content).toContain('重命名')
  })

  it('path constraint takes precedence over confirmation', async () => {
    const run = vi.fn().mockResolvedValue({})
    const confirm = vi.fn().mockResolvedValue({ accepted: true })
    const tool = createStubTool({
      name: 'CreateFile',
      run,
      buildConfirmation: (input) => ({ kind: 'create', path: (input as { path: string }).path, content: '' }),
    })
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>

    await executeAgentTool({
      call: createCall('CreateFile', { path: 'outline.txt' }),
      project: stubProject,
      tools,
      confirm,
      toolPolicy: { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' },
    })

    // 路径不匹配直接拒，不弹确认
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
