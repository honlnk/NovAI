import type { ProjectSnapshot } from '../../types/project'

export type CoreToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'

export type ToolRuntime = {
  project: ProjectSnapshot
  readFileStates?: Map<string, ReadFileState>
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

/**
 * 工具层声明的结构化文件变更，由写工具在执行成功后产出。
 * service 层据此推导 changedFiles，不再依赖工具结果文本反推。
 */
export type FileChange =
  | { type: 'created'; path: string }
  | { type: 'updated'; path: string }
  | { type: 'renamed'; fromPath: string; toPath: string }
  | { type: 'deleted'; path: string; trashPath?: string }

/**
 * 写工具执行前构造的确认预览，用于「写入前确认」流程。
 * create/edit 携带完整文本用于 diff；rename/delete 仅路径级预览。
 */
export type WriteConfirmation =
  | { kind: 'create'; path: string; content: string }
  | { kind: 'edit'; path: string; oldText: string; newText: string }
  | { kind: 'rename'; fromPath: string; toPath: string }
  | { kind: 'delete'; path: string }

export type ToolDefinition<TName extends CoreToolName, TInput, TOutput> = {
  name: TName
  description: string
  validateInput(input: unknown): TInput
  run(input: TInput, runtime: ToolRuntime): Promise<TOutput>
  summarizeInput(input: TInput): string
  summarizeOutput(output: TOutput): string
  /**
   * 写工具用它声明结构化文件变更；只读工具不实现。
   * 返回 undefined 表示该 output 不产生文件变更。
   */
  extractFileChange?(output: TOutput): FileChange | undefined
  /**
   * 写工具用它构造写入前确认预览；只读工具不实现。
   * 入参是经过 validateInput 校验的强类型 input，执行前调用。
   */
  buildConfirmation?(input: TInput): WriteConfirmation
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
  readFileState: ReadFileState
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  empty: boolean
  offsetBeyondEnd: boolean
  fileSizeBytes: number
  notice?: string
}

export type ReadFileState = {
  path: string
  contentHash: string
  lastModified: string
  fileSizeBytes: number
}

export type EditFileInput = {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
  readFileState?: ReadFileState
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
  linesAdded: number
  created: true
}

export type RenameFileInput = {
  fromPath: string
  toPath: string
}

export type RenameFileOutput = {
  fromPath: string
  toPath: string
  contentLength: number
}

export type DeleteFileInput = {
  path: string
}

export type DeleteFileOutput = {
  path: string
  trashPath: string
  contentLength: number
  linesRemoved: number
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

export type RagSearchInput = {
  query: string
  topK?: number
  finalLimit?: number
  filters?: {
    type?: Array<'character' | 'location' | 'entity' | 'timeline' | 'plot' | 'worldbuilding'>
    tags?: string[]
    lastUpdatedChapter?: string
  }
}

export type RagSearchOutput = {
  query: string
  recalledCount: number
  returnedCount: number
  usedRerank: boolean
  candidates: Array<{
    id: string
    sourcePath: string
    type: 'character' | 'location' | 'entity' | 'timeline' | 'plot' | 'worldbuilding'
    name: string
    summary: string
    retrievalText: string
    tags: string[]
    lastUpdatedChapter: string
    relatedChapters: string[]
    score?: number
    rerankScore?: number
  }>
}
