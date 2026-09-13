import { describe, expect, it, vi } from 'vitest'

import { executeAgentTool } from './tool-execution'
import { SPILL_THRESHOLD_CHARS } from './spill'
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

describe('executeAgentTool 长文本 spill', () => {
  const spillProject = {
    handle: {
      async getDirectoryHandle() {
        throw new Error('不应触发 spill 落盘')
      },
    },
  } as unknown as ProjectSnapshot

  it('ReadFile 超长结果被 spill：结果内容替换为预览 + 引用', async () => {
    const longContent = '章'.repeat(SPILL_THRESHOLD_CHARS + 100)
    const tool = createStubTool({
      name: 'ReadFile',
      isReadOnly: true,
      run: async () => ({ path: 'chapters/001.txt', content: longContent }),
    })
    // formatResult 直接返回长内容，触发 spill 分支
    ;(tool as { formatResult: () => string }).formatResult = () => longContent
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>

    // 用可写盘的项目验证落盘：这里给一个能写的 handle 太重，改用未超阈值的对照 + 阈值判断
    const writableProject = { handle: createWritableMemoryHandle() } as unknown as ProjectSnapshot
    const result = await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: writableProject,
      tools,
    })

    expect(result.content.length).toBeLessThan(SPILL_THRESHOLD_CHARS)
    expect(result.content).toContain('已省略')
    expect(result.content).toContain('.novel/spill/')
  })

  it('未超阈值的结果原样通过', async () => {
    const tool = createStubTool({
      name: 'ReadFile',
      isReadOnly: true,
      run: async () => ({ path: 'chapters/001.txt', content: '短内容' }),
    })
    ;(tool as { formatResult: () => string }).formatResult = () => '短内容'
    const tools = { ReadFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('ReadFile', { path: 'chapters/001.txt' }),
      project: spillProject,
      tools,
    })

    expect(result.content).toBe('短内容')
  })

  it('写工具（CreateFile）的超长结果不 spill：内容是模型自己写的', async () => {
    const longContent = '章'.repeat(SPILL_THRESHOLD_CHARS + 100)
    const tool = createStubTool({
      name: 'CreateFile',
      run: async () => ({ path: 'chapters/new.txt' }),
    })
    ;(tool as { formatResult: () => string }).formatResult = () => longContent
    const tools = { CreateFile: tool } as unknown as Record<string, AgentRunnableTool>

    const result = await executeAgentTool({
      call: createCall('CreateFile', { path: 'chapters/new.txt' }),
      project: spillProject,
      tools,
    })

    expect(result.content).toBe(longContent)
  })
})

/** 可写的最小内存 handle（spill 落盘用） */
function createWritableMemoryHandle(): FileSystemDirectoryHandle {
  type FileEntry = { kind: 'file'; name: string; content: string }
  type DirEntry = { kind: 'directory'; name: string; entries: Map<string, FileEntry | DirEntry> }
  const root: DirEntry = { kind: 'directory', name: 'novel', entries: new Map() }

  const toDirHandle = (dir: DirEntry): FileSystemDirectoryHandle =>
    ({
      kind: 'directory',
      name: dir.name,
      async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
        const current = dir.entries.get(name)
        if (current?.kind === 'directory') return toDirHandle(current)
        if (!options?.create) throw new Error(`Not found: ${name}`)
        const next: DirEntry = { kind: 'directory', name, entries: new Map() }
        dir.entries.set(name, next)
        return toDirHandle(next)
      },
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        const current = dir.entries.get(name)
        if (current?.kind === 'file') return toFileHandle(current)
        if (!options?.create) throw new Error(`Not found: ${name}`)
        const next: FileEntry = { kind: 'file', name, content: '' }
        dir.entries.set(name, next)
        return toFileHandle(next)
      },
    }) as unknown as FileSystemDirectoryHandle

  const toFileHandle = (file: FileEntry): FileSystemFileHandle =>
    ({
      kind: 'file',
      name: file.name,
      async getFile() {
        return new File([file.content], file.name, { type: 'text/plain' })
      },
      async createWritable() {
        return {
          async write(data: FileSystemWriteChunkType) {
            file.content = typeof data === 'string' ? data : ''
          },
          async close() {},
        } as unknown as FileSystemWritableFileStream
      },
    }) as unknown as FileSystemFileHandle

  return toDirHandle(root)
}

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
