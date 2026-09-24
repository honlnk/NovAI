import type { PermissionPreset, SearchConfig } from '../types/project'
import type { ReasoningEffort } from '../types/ai'

// app 层的合法导入面（services/*、types/*）；思考档位可见性按协议 × 方言过滤时使用
export { isDeepSeekDialect } from '../core/ai/shared'

export type ProjectFileNodeView = {
  name: string
  path: string
  kind: 'file' | 'directory'
  children?: ProjectFileNodeView[]
}

export type ProjectConfigView = {
  version: number
  project: {
    name: string
    createdAt: string
    updatedAt: string
  }
  llm: {
    baseUrl: string
    apiKey: string
    model: string
    /** LLM 服务的 API 协议；生成链路当前仅实现 openai（Chat Completions 兼容）。 */
    protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
    /** 思考强度档位（输入框选择器写回）；缺省 default = 不传思考参数。 */
    reasoningEffort?: ReasoningEffort
  }
  embedding: {
    baseUrl: string
    apiKey: string
    model: string
  }
  rerank: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    mode: 'text'
    topN: number
  }
  completion: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    debounceMs: number
    maxTokens: number
  }
  search: SearchConfig
  settings: {
    ragCandidateLimit: number
    ragContextMaxItems: number
    conversationTokenLimit: number
    compressionKeepRecentTurns: number
    agentMaxTurns: number
    /** 写工具权限档位（五档，判定规则见 core/agent/permission.ts） */
    permissionPreset: PermissionPreset
    embeddingTextVersion: number
    enableDebugLogging: boolean
    activeScenePromptPath: string | null
  }
}

export type ProjectInfoView = ProjectConfigView['project']

export type LlmConfigView = ProjectConfigView['llm']

export type EmbeddingConfigView = ProjectConfigView['embedding']

export type RerankConfigView = ProjectConfigView['rerank']

export type CompletionConfigView = ProjectConfigView['completion']

export type SearchConfigView = ProjectConfigView['search']

export type ProjectSettingsView = ProjectConfigView['settings']

export type ProjectConfigPatch = Partial<{
  project: Partial<ProjectInfoView>
  llm: Partial<LlmConfigView>
  embedding: Partial<EmbeddingConfigView>
  rerank: Partial<RerankConfigView>
  completion: Partial<CompletionConfigView>
  search: Partial<SearchConfigView>
  settings: Partial<ProjectSettingsView>
}>

export type ConnectionTestResultView = {
  ok: boolean
  message: string
}

/** 拉取模型列表的输入；protocol 仅 LLM 配置使用，其余配置固定 OpenAI 兼容协议。 */
export type ListModelsInputView = {
  baseUrl: string
  apiKey: string
  protocol?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
}

/**
 * models 为服务返回的全量列表，filtered 为按用途过滤后的子集（未指定 purpose 时两者相同）。
 * source 为 builtin 时表示结果来自内置清单（百炼 embedding / rerank 不走 API 拉取）。
 */
export type ListModelsResultView = {
  models: string[]
  filtered: string[]
  source: 'api' | 'builtin'
}

export type ModelListPurposeView = 'llm' | 'embedding' | 'rerank' | 'completion'

export type ChatTargetView = {
  type:
    | 'project'
    | 'chapter'
    | 'prompt-system'
    | 'prompt-scene'
    | 'element'
  primaryPath?: string
  groupName?: string
  displayName: string
  derivedFrom: 'selection' | 'preview' | 'instruction'
}

export type LlmStreamEventView =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; text: string }
  | { type: 'error'; message: string }

export type LlmStreamInputView = {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt?: string
  instruction: string
}

/**
 * 对话输入框 AI 补全（FIM）事件流，与 LlmStreamEventView 同构。
 */
export type FimCompletionEventView =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; text: string }
  | { type: 'error'; message: string }

/**
 * FIM 补全请求输入。prompt 为光标前文本（前缀），suffix 为光标后文本（后缀，提示词场景通常为空）。
 * signal 用于在用户继续打字时中断上一次未完成的请求。
 */
export type FimCompletionInputView = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  suffix?: string
  maxTokens?: number
  signal?: AbortSignal
}

export type ElementTypeView = 'character' | 'location' | 'entity' | 'timeline' | 'plot' | 'worldbuilding'

export type IndexStatusView = 'empty' | 'building' | 'ready' | 'stale' | 'rebuilding' | 'error'

export type ProjectIndexMetaView = {
  projectId: string
  status: IndexStatusView
  documentCount: number
  embeddingProvider: string
  embeddingModel: string
  embeddingDim: number
  embeddingTextVersion: number
  rerankProvider?: string
  rerankModel?: string
  lastBuildAt?: string
  lastFullRebuildAt?: string
  lastError?: string
}

export type IndexBuildResultView = {
  projectId: string
  status: IndexStatusView
  indexedCount: number
  skippedCount: number
  failedCount: number
  message: string
}

export type RetrievalCandidateView = {
  id: string
  projectId: string
  sourcePath: string
  type: ElementTypeView
  name: string
  summary: string
  retrievalText: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  score?: number
  rerankScore?: number
}

export type GenerationContextDraftView = {
  query: string
  recentChapters: Array<{
    path: string
    title: string
    content: string
  }>
  retrievedCandidates: RetrievalCandidateView[]
  rerankedCandidates: RetrievalCandidateView[]
  finalContextItems: RetrievalCandidateView[]
}

export type RetrievalExplanationView = {
  id: string
  name: string
  type: ElementTypeView
  summary: string
  sourcePath: string
  selectedBy: 'recall' | 'rerank' | 'final-context'
  reason: string
  lastUpdatedChapter: string
}

export type ElementExtractionItemView = {
  type: ElementTypeView
  name: string
  summary: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
  body: string
}

export type ElementExtractionResultView = {
  characters: ElementExtractionItemView[]
  locations: ElementExtractionItemView[]
  entities: ElementExtractionItemView[]
  timeline: ElementExtractionItemView[]
  plots: ElementExtractionItemView[]
  worldbuilding: ElementExtractionItemView[]
}

export type ElementWriteResultView = {
  created: string[]
  updated: string[]
  skipped: string[]
  staleIndex: boolean
}

export type ProjectView = {
  id: string
  name: string
  rootName: string
  files: ProjectFileNodeView[]
  config: ProjectConfigView
  activeFilePath?: string
}

export type ProjectStatusView = {
  projectId: string
  rootName: string
  canLoad: boolean
  issues: ProjectIssueView[]
}

export type LastProjectSummaryView = {
  projectId: string
  name: string
  rootName: string
  lastOpenedAt: string
  chapterCount: number
  elementCount: number
}

export type FileContentView = {
  path: string
  name: string
  format: 'markdown' | 'json' | 'text'
  content: string
  updatedAt: string
}

export type ProjectIssueView =
  | 'missing-config'
  | 'invalid-config'
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'missing-prompts-system'
  | 'missing-prompts-scenes'
  | 'missing-chapters'
  | 'missing-elements'
  | 'missing-internal-directory'

export type ToolNameView =
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

export type ToolCallView = {
  id: string
  name: ToolNameView
  inputSummary: string
  input?: unknown
  createdAt: string
}

export type ToolResultView = {
  callId: string
  name: ToolNameView
  ok: boolean
  resultSummary: string
  output?: unknown
  error?: NovAiError
  createdAt: string
}

export type ChangedFileView =
  | {
      type: 'created'
      path: string
    }
  | {
      type: 'updated'
      path: string
    }
  | {
      type: 'renamed'
      fromPath: string
      toPath: string
    }
  | {
      type: 'deleted'
      path: string
      trashPath?: string
      /** 被删行数（只带数字不带内容；旧账本记录无此字段，视为 0） */
      linesRemoved?: number
    }

/**
 * 改动账本记录的视图（change-summary 面板数据：按 runId 从账本解析后装进消息 view）。
 * diff 仅 created/updated 有。
 */
export type FileChangeRecordView = {
  id: string
  runId: string
  at: string
  change: ChangedFileView
  diff?: {
    oldText: string
    newText: string
    linesAdded: number
    linesRemoved: number
  }
}

/**
 * 写回面板的文件级聚合视图：一轮内同一文件的多次操作折叠为一个文件行
 * （面板回答「此次任务改了哪些文件、每个文件总共改了什么」，而非平铺操作流水）。
 */
export type TurnFileChangeView = {
  /** 聚合 key = 最终路径（renamed 取 toPath） */
  path: string
  /** 含 renamed 记录时携带原路径（面板展示 fromPath → toPath） */
  fromPath?: string
  /**
   * 净状态：末次内容操作为 deleted → deleted；首次为 created（无论中间是否改名）→ created；
   * 含 renamed → renamed；其余 → updated。
   */
  status: 'created' | 'updated' | 'renamed' | 'deleted'
  /** 该文件本轮各片段 diff 行数之和（按 oldText/newText 实时重算，与展开渲染同源；历史账本旧口径数字自愈） */
  linesAdded: number
  linesRemoved: number
  /** 该文件本轮的全部原始改动记录（账本顺序）；面板展开渲染片段 diff 用 */
  records: FileChangeRecordView[]
}

export type ChatMessageView =
  | {
      id: string
      role: 'user'
      kind: 'text'
      text: string
      /** 引用的选中内容，渲染为用户气泡内的独立引用块 */
      quote?: string
      /** 插话产生的用户消息：渲染与普通气泡相同，仅作分组边界判定的数据标记（不是组边界） */
      steered?: boolean
      createdAt: string
    }
  | {
      id: string
      role: 'assistant'
      kind: 'text' | 'action-summary'
      text: string
      /** 思考流文本（reasoning 模型输出；展示 + 按协议要求随历史回传）。思考后直接调工具的轮次 text 为空、仅带 reasoning。 */
      reasoning?: string
      /** anthropic 思考块签名（回传 thinking block 时携带；仅 UI 会话重建用，渲染层不消费）。 */
      thinkingSignature?: string
      targetPath?: string
      relatedPaths?: string[]
      createdAt: string
    }
  | {
      id: string
      role: 'system'
      kind: 'change-summary'
      runId: string
      aborted?: boolean
      /** 本轮改动按文件聚合（面板数据，从会话账本按 runId 解析后聚合；账本缺该 runId 时为空数组，UI 降级渲染） */
      files: TurnFileChangeView[]
      createdAt: string
    }
  | {
      id: string
      role: 'system'
      kind: 'tool-call'
      text: string
      toolName: ToolNameView
      /** 与 tool-result 配对的调用 id；旧会话消息无此字段，UI 各自独立成行不报错 */
      toolCallId?: string
      createdAt: string
    }
  | {
      id: string
      role: 'system'
      kind: 'tool-result'
      text: string
      ok: boolean
      toolName: ToolNameView
      /** 与 tool-call 配对的调用 id；旧会话消息无此字段，UI 各自独立成行不报错 */
      toolCallId?: string
      createdAt: string
    }
  | {
      id: string
      role: 'system'
      kind: 'context-summary' | 'turn-limit' | 'error'
      text: string
      createdAt: string
    }

export type ChatSessionView = {
  sessionId: string
  projectId: string
  status: 'idle' | 'running' | 'waiting-user' | 'awaiting-confirmation' | 'error'
  messages: ChatMessageView[]
  /**
   * 历史窗口起点：messages[0] 在全量数组中的下标（游标即 append-only 数组下标）。
   * 仅在 getSession 传 tailMessages 且发生截断时存在；缺省/0 表示已是全部历史。
   * 前端据此推导 hasMore = historyStart > 0。
   */
  historyStart?: number
  currentTargetPath?: string
  /** 会话级改动清单（按目标路径去重，从改动账本派生；重载后不丢） */
  changedFiles: ChangedFileView[]
  /** 会话级改动文件总数（changedFiles 的长度，从改动账本派生） */
  changedFileCount?: number
  /** 收件箱队列快照（QueueDock 切换会话时重建用） */
  queuedMessages?: QueuedMessageView[]
  /** 会话标题，可选以兼容旧 view */
  title?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * 一页更早历史（loadOlderMessages 的返回体）：窗口 [start, before) 的消息视图与新起点。
 * messages 为空且 start 为 0 表示没有更早历史。
 */
export type ChatHistoryPageView = {
  messages: ChatMessageView[]
  start: number
}

/**
 * 历史会话列表项：只携带列表展示所需的摘要字段，不含完整消息体。
 * listSessions 返回该数组，供前端对话分类面板渲染。
 */
export type ChatSessionSummaryView = {
  sessionId: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/** 发送入口参数：入队先于唤醒，立即返回；mode = 'queue' 排队（空闲等同直接发送）/ 'steer' 插话。 */
export type EnqueueMessageInput = {
  projectId: string
  sessionId?: string
  text: string
  /** 引用的选中内容，随消息入队快照 */
  quote?: string
  mode: 'queue' | 'steer'
  /** 发送时打开的文件路径（隐式上下文快照，目标解析用） */
  activeFilePath?: string | null
}

/** 排队消息操作：edit 行内编辑 / remove 撤回 / steer 升级为插话（仅运行中可用）。 */
export type UpdateQueuedMessageInput = {
  projectId: string
  sessionId: string
  id: string
  action: { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' }
}

/** QueueDock 渲染用排队消息视图：placement = queued（next-turn 排队）/ steering（next-step 插话）。 */
export type QueuedMessageView = {
  id: string
  text: string
  quote?: string
  at: string
  placement: 'queued' | 'steering'
}

/**
 * 一次连续运行（driver run）的收尾结果。
 * turnChanges = 本次运行期间账本新增记录（跨 turn 全量，含 diff）；
 * sessionChangedFileCount = 会话级去重总数（喂右下角）。
 */
export type RunAgentTurnResult = {
  projectId: string
  sessionId: string
  targetPath?: string
  turnChanges: FileChangeRecordView[]
  sessionChangedFileCount: number
  session: ChatSessionView
}

export type WriteConfirmationView =
  | { kind: 'create'; path: string; content: string }
  | { kind: 'edit'; path: string; oldText: string; newText: string }
  | { kind: 'rename'; fromPath: string; toPath: string }
  | { kind: 'delete'; path: string }

export type FileChangeConfirmationView = {
  id: string
  toolName: ToolNameView
  title: string
  summary: string
  /** 写工具执行前的预览数据，用于 UI 展示 diff。 */
  confirmation: WriteConfirmationView
}

export type AgentUiEvent =
  | { type: 'run-start'; runId: string; sessionId: string }
  | { type: 'message'; sessionId: string; message: ChatMessageView }
  /** 模型流式输出的文本增量（瞬态渲染态）；同一条 assistant 消息共享稳定 messageId，最终由 message 事件原位落盘。 */
  | { type: 'message-delta'; sessionId: string; messageId: string; text: string }
  /** 思考流增量（瞬态渲染态）；与正文 delta 共享 messageId，思考先于正文，正文开始即收起思考块。 */
  | { type: 'message-reasoning-delta'; sessionId: string; messageId: string; text: string }
  | { type: 'model-start'; sessionId: string; step: number }
  | { type: 'model-finish'; sessionId: string; step: number; toolCallCount: number; finishReason?: string }
  | { type: 'tool-call'; sessionId: string; toolCall: ToolCallView }
  | { type: 'tool-result'; sessionId: string; toolResult: ToolResultView }
  /** 写工具落盘后广播（载荷为完整账本记录）；文件树刷新用。 */
  | { type: 'file-changed'; sessionId: string; file: FileChangeRecordView }
  /** 收件箱任何变化（入队/抽干/编辑/删除）时广播全量快照。 */
  | { type: 'queue-updated'; sessionId: string; queue: QueuedMessageView[] }
  | { type: 'confirmation-required'; sessionId: string; request: FileChangeConfirmationView }
  | { type: 'run-error'; sessionId: string; error: NovAiError }
  /** driver 一次连续运行收敛（抽干收工/停止收尾）；多 turn 时只在最后发一次。 */
  | { type: 'run-finish'; sessionId: string; result: RunAgentTurnResult }

export type NovAiErrorCode =
  | 'PROJECT_NOT_OPEN'
  | 'PROJECT_PERMISSION_DENIED'
  | 'FILE_NOT_FOUND'
  | 'FILE_WRITE_FAILED'
  | 'MODEL_CONFIG_MISSING'
  | 'MODEL_REQUEST_FAILED'
  | 'TOOL_INPUT_INVALID'
  | 'TOOL_EXECUTION_FAILED'
  | 'RAG_INDEX_EMPTY'
  | 'RAG_REQUEST_FAILED'
  | 'RUN_ABORTED'
  | 'UNKNOWN_ERROR'

export type NovAiError = {
  code: NovAiErrorCode
  message: string
  recoverable: boolean
  detail?: unknown
}
