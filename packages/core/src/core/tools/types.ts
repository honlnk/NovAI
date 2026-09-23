import type { ProjectSnapshot } from '../../types/project'
import type { FileChangeRecord } from '../../types/chat'

export type CoreToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'RagSearch'
  | 'GetFileChangeHistory'
  | 'WebSearch'
  | 'WebFetch'

export type ToolRuntime = {
  project: ProjectSnapshot
  readFileStates?: Map<string, ReadFileState>
  /**
   * 会话改动账本的只读取口（GetFileChangeHistory 用）。
   * getter 形态：账本每次累积都不可变重建数组，引用快照会过期，读时取最新。
   */
  getChangeLedger?: () => readonly FileChangeRecord[]
  /**
   * 联网搜索的匿名身份（localStorage UUID，app 层注入）：
   * linkseek 托管档绿灯用它认配额（X-NovAI-Client-Id）；缺失时服务端按 IP 计。
   */
  webClientId?: string
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
  /** deleted 带被删行数（只带数字不带内容：原文去回收站 trashPath 看，账本会话落盘不重复存） */
  | { type: 'deleted'; path: string; trashPath?: string; linesRemoved?: number }

/**
 * 片段级 diff（改动账本 FileChangeRecord 的唯一 diff 载体，抄 dsh 写时 before/after 机制）：
 * 只存被替换的片段，不存整文件。created 时 oldText 为 ''（全新内容），deleted/renamed 不产生 diff。
 * modelView 里的 tool 消息不挂 diff（模型不需要逐行 diff，省 token）。
 */
export type ChangeDiff = {
  /** 被替换掉的原文片段；CreateFile 时为 '' */
  oldText: string
  /** 替换后的新片段；DeleteFile 时为 '' */
  newText: string
  linesAdded: number
  linesRemoved: number
}

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
   * 写工具用它产出片段级 diff（改动账本用）；EditFile/CreateFile 实现，RenameFile/DeleteFile 不实现。
   * 返回 undefined 表示该 output 无 diff 可存。
   */
  extractChangeDiff?(output: TOutput): ChangeDiff | undefined
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
  /** 第三道闸命中：返回内容达单次字节上限被截断（用 offset=endLine+1 继续读）。 */
  truncatedByBytes?: boolean
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
  /** 实际应用的原文片段（经 findActualText/preserveQuoteStyle 校正，非模型入参原样）；改动账本 diff 用 */
  oldText: string
  /** 实际写入的新片段 */
  newText: string
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
  /** 新建的完整内容；改动账本 diff 用（oldText 为 ''，全绿） */
  content: string
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

export type GetFileChangeHistoryInput = {
  /** 返回条数上限：默认 20，最大 100 */
  limit: number
  /** 只看某个文件（含改名前后路径） */
  path?: string
  /** 只看某一轮（runId） */
  runId?: string
}

export type GetFileChangeHistoryOutput = {
  /** 纯文本清单（新→旧逐条），末尾「共 N 条记录」 */
  content: string
  /** 过滤后的总记录数 */
  totalCount: number
  /** 实际返回条数 */
  returnedCount: number
}

export type WebSearchInput = {
  /** 1-4 条搜索 query（多 query 并发 + 去重合并） */
  queries: string[]
}

export type WebSearchOutput = {
  queries: string[]
  /** provider 生成的答案摘要（仅生成式后端有） */
  content?: string
  sources: Array<{
    title: string
    url: string
    snippet: string
    publishedAt?: string
  }>
  /** 合并后超出上限被截断 */
  truncated: boolean
}

export type WebFetchInput = {
  url: string
}

export type WebFetchOutput = {
  /** 模型给的原始 URL */
  url: string
  /** 重定向链终点 */
  finalUrl?: string
  /** 终点 HTTP 状态码（后端不提供时缺省） */
  statusCode?: number
  /** 正文（markdown；超 50,000 字符截断并附提示） */
  content: string
  truncated: boolean
  /** 'browser' = 服务端浏览器渲染；缺省视为 http */
  renderedBy?: 'http' | 'browser'
  /** 服务端附带提示（如渲染升级失败的降级说明） */
  notice?: string
}
