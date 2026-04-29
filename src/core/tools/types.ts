import type { ProjectSnapshot } from '../../types/project'

export type CoreToolName = 'ReadFile' | 'EditFile' | 'CreateFile' | 'ListDirectory' | 'FindFiles'

export type ToolRuntime = {
  project: ProjectSnapshot
}

export type ToolCall<TName extends CoreToolName = CoreToolName, TInput = unknown> = {
  id: string
  name: TName
  input: TInput
  createdAt: string
}

export type ToolResult<TName extends CoreToolName = CoreToolName, TOutput = unknown> = {
  callId: string
  name: TName
  ok: boolean
  output?: TOutput
  error?: string
  summary: string
  createdAt: string
}

export type ToolExecution<TName extends CoreToolName = CoreToolName, TInput = unknown, TOutput = unknown> = {
  call: ToolCall<TName, TInput>
  result: ToolResult<TName, TOutput>
}

export type ToolDefinition<TName extends CoreToolName, TInput, TOutput> = {
  name: TName
  description: string
  validateInput(input: unknown): TInput
  run(input: TInput, runtime: ToolRuntime): Promise<TOutput>
  summarizeInput(input: TInput): string
  summarizeOutput(output: TOutput): string
}

export type ReadFileInput = {
  path: string
  offset?: number
  limit?: number
}

export type ReadFileOutput = {
  path: string
  content: string
  numberedContent: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
}

export type EditFileInput = {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
}

export type EditFileOutput = {
  path: string
  occurrences: number
  contentLength: number
  linesAdded: number
  linesRemoved: number
}

export type CreateFileInput = {
  path: string
  content: string
}

export type CreateFileOutput = {
  path: string
  contentLength: number
  created: true
}

export type ListDirectoryInput = {
  path?: string
  showHidden?: boolean
}

export type ListDirectoryEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
  hidden: boolean
}

export type ListDirectoryOutput = {
  path: string
  entries: ListDirectoryEntry[]
}

export type FindFilesInput = {
  pattern: string
  path?: string
  includeHidden?: boolean
  limit?: number
}

export type FindFilesOutput = {
  pattern: string
  path: string
  filenames: string[]
  numFiles: number
  truncated: boolean
}
