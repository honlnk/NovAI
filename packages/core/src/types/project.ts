import type { ModelProtocol } from './ai'

export type ProjectSummary = {
  id: string
  name: string
  updatedAt: string
  chapterCount: number
  elementCount: number
  wordCount: number
}

export type RecentProject = ProjectSummary

export type TreeNode = {
  name: string
  path: string
  kind: 'file' | 'directory'
  children?: TreeNode[]
}

export type ProjectConfig = {
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
    /**
     * LLM 服务的 API 协议。当前生成链路仅实现 OpenAI 兼容协议，
     * anthropic / gemini 仅在配置层（拉取模型列表、测试连接）支持。
     */
    protocol: ModelProtocol
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
  /**
   * 对话输入框 AI 补全（FIM）配置。
   *
   * 默认关闭，需用户在设置中主动开启并填写 DeepSeek FIM 的地址、Key、模型，
   * 开启后才会在对话输入框触发 ghost text 补全。与主 LLM 独立，互不影响。
   */
  completion: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    debounceMs: number
    maxTokens: number
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
    enableDebugLogging: boolean
    /**
     * 当前激活的场景级提示词路径（相对于项目根，如 prompts/scenes/scene-001.md）。
     * 留空时不注入任何场景提示词；切换后会话首轮注入生效。
     */
    activeScenePromptPath: string | null
  }
}

export type ProjectManifest = {
  version: number
  projectId: string
  createdAt: string
  lastOpenedAt: string
}

export type ProjectIssue =
  | 'missing-config'
  | 'invalid-config'
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'missing-prompts-system'
  | 'missing-prompts-scenes'
  | 'missing-chapters'
  | 'missing-elements'
  | 'missing-internal-directory'

export type ProjectInspection = {
  rootName: string
  issues: ProjectIssue[]
  canLoad: boolean
}

export type ProjectSnapshot = {
  id: string
  name: string
  rootName: string
  handle: FileSystemDirectoryHandle
  config: ProjectConfig
  manifest: ProjectManifest
  tree: TreeNode[]
  metadata: RecentProject
}

export type ProjectFileContent = {
  path: string
  name: string
  content: string
  format: 'markdown' | 'json' | 'text'
  updatedAt: string
}
