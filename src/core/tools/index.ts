import {
  createFileTool,
  editFileTool,
  readFileTool,
} from './file-tools'
import { findFilesTool, listDirectoryTool } from './directory-tools'
import type {
  CoreToolName,
  CreateFileInput,
  CreateFileOutput,
  EditFileInput,
  EditFileOutput,
  FindFilesInput,
  FindFilesOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  ReadFileInput,
  ReadFileOutput,
  ToolCall,
  ToolDefinition,
  ToolExecution,
  ToolResult,
  ToolRuntime,
} from './types'

export type {
  CoreToolName,
  CreateFileInput,
  CreateFileOutput,
  EditFileInput,
  EditFileOutput,
  FindFilesInput,
  FindFilesOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  ReadFileInput,
  ReadFileOutput,
  ToolCall,
  ToolExecution,
  ToolResult,
  ToolRuntime,
}

type ToolOutputMap = {
  ReadFile: ReadFileOutput
  EditFile: EditFileOutput
  CreateFile: CreateFileOutput
  ListDirectory: ListDirectoryOutput
  FindFiles: FindFilesOutput
}

const tools = {
  ReadFile: readFileTool,
  EditFile: editFileTool,
  CreateFile: createFileTool,
  ListDirectory: listDirectoryTool,
  FindFiles: findFilesTool,
} satisfies Record<CoreToolName, ToolDefinition<CoreToolName, unknown, unknown>>

export function getCoreTools() {
  return tools
}

export function getCoreTool(name: CoreToolName) {
  return tools[name]
}

export async function executeCoreTool<TName extends CoreToolName>(
  name: TName,
  input: unknown,
  runtime: ToolRuntime,
): Promise<ToolExecution<TName, unknown, ToolOutputMap[TName]>> {
  const tool = tools[name] as ToolDefinition<TName, unknown, ToolOutputMap[TName]>
  const call: ToolCall<TName, unknown> = {
    id: createToolCallId(),
    name,
    input,
    createdAt: new Date().toISOString(),
  }

  try {
    const validatedInput = tool.validateInput(input)
    const output = await tool.run(validatedInput, runtime)

    return {
      call,
      result: {
        callId: call.id,
        name,
        ok: true,
        output,
        summary: tool.summarizeOutput(output),
        createdAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${name} 执行失败`

    return {
      call,
      result: {
        callId: call.id,
        name,
        ok: false,
        error: message,
        summary: message,
        createdAt: new Date().toISOString(),
      },
    }
  }
}

function createToolCallId() {
  return `tool-${Math.random().toString(36).slice(2, 10)}`
}
