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
    mode: 'text' | 'multimodal'
    topN: number
  }
  settings: {
    generationRecentChapters: number
    ragCandidateLimit: number
    ragContextMaxItems: number
    proofreadDefaultChapters: number
    organizeDefaultChapters: number
    conversationTokenLimit: number
    compressionKeepRecentTurns: number
    embeddingTextVersion: number
    enableBackgroundIndexing: boolean
  }
}

export type ProjectInfoView = ProjectConfigView['project']

export type LlmConfigView = ProjectConfigView['llm']

export type EmbeddingConfigView = ProjectConfigView['embedding']

export type RerankConfigView = ProjectConfigView['rerank']

export type ProjectSettingsView = ProjectConfigView['settings']

export type ProjectConfigPatch = Partial<{
  project: Partial<ProjectInfoView>
  llm: Partial<LlmConfigView>
  embedding: Partial<EmbeddingConfigView>
  rerank: Partial<RerankConfigView>
  settings: Partial<ProjectSettingsView>
}>

export type ConnectionTestResultView = {
  ok: boolean
  message: string
}

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

export type ElementTypeView = 'character' | 'location' | 'timeline' | 'plot' | 'worldbuilding'

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
  timeline: ElementExtractionItemView[]
  plots: ElementExtractionItemView[]
  worldbuilding: ElementExtractionItemView[]
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
    }

export type ChatMessageView =
  | {
      id: string
      role: 'user'
      kind: 'text'
      text: string
      createdAt: string
    }
  | {
      id: string
      role: 'assistant'
      kind: 'text' | 'action-summary'
      text: string
      targetPath?: string
      relatedPaths?: string[]
      createdAt: string
    }
  | {
      id: string
      role: 'system'
      kind: 'tool-call' | 'tool-result' | 'context-summary' | 'error'
      text: string
      ok?: boolean
      toolName?: ToolNameView
      createdAt: string
    }

export type ChatSessionView = {
  sessionId: string
  projectId: string
  status: 'idle' | 'running' | 'waiting-user' | 'awaiting-confirmation' | 'error'
  messages: ChatMessageView[]
  currentDraftText: string
  currentTargetPath?: string
  lastChangedFile?: ChangedFileView
}

export type RunAgentTurnInput = {
  projectId: string
  sessionId?: string
  instruction: string
  activeFilePath?: string
  onEvent?: (event: AgentUiEvent) => void
}

export type RunAgentTurnResult = {
  projectId: string
  sessionId: string
  targetPath?: string
  changedFiles: ChangedFileView[]
  session: ChatSessionView
}

export type FileChangeConfirmationView = {
  id: string
  toolName: ToolNameView
  title: string
  summary: string
  changedFiles: ChangedFileView[]
}

export type AgentUiEvent =
  | { type: 'run-start'; runId: string; sessionId: string }
  | { type: 'message'; message: ChatMessageView }
  | { type: 'assistant-delta'; text: string; fullText: string }
  | { type: 'model-start'; step: number }
  | { type: 'model-finish'; step: number; toolCallCount: number; finishReason?: string }
  | { type: 'tool-call'; toolCall: ToolCallView }
  | { type: 'tool-result'; toolResult: ToolResultView }
  | { type: 'file-changed'; file: ChangedFileView }
  | { type: 'confirmation-required'; request: FileChangeConfirmationView }
  | { type: 'run-error'; error: NovAiError }
  | { type: 'run-finish'; result: RunAgentTurnResult }

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
