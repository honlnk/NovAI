import type { ModelProtocol } from './ai'

/**
 * 写工具权限档位：review=仅审阅 / chapter=章节内容 / material=素材内容 /
 * chapter-material=章节+素材（默认） / full=完全访问。
 * 判定规则见 core/agent/permission.ts。
 */
export type PermissionPreset = 'review' | 'chapter' | 'material' | 'chapter-material' | 'full'

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

/**
 * 联网搜索来源档位（决策 0006）。
 *
 * 工具契约恒定（WebSearch/WebFetch schema 不随后端变化），档位只决定
 * provider 实现与抓取能力：linkseek 系两档带抓取（含质量门控自动渲染升级），
 * Exa / Perplexity 为纯搜索 API，无抓取（浏览器直连被目标站 CORS 挡死）。
 */
export type SearchProviderKind = 'linkseek-hosted' | 'linkseek-selfhost' | 'exa' | 'perplexity'

export type SearchConfig = {
  provider: SearchProviderKind
  /**
   * 自定义服务地址：linkseek-selfhost 必填（用户实例根地址）；
   * exa / perplexity 可覆盖默认官方地址；linkseek-hosted 缺省用内置常量（部署前为占位）。
   */
  baseUrl: string
  /** selfhost / exa / perplexity 的 API Key；hosted 匿名绿灯不需要。 */
  apiKey: string
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
    mode: 'text'
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
  /** 联网搜索（WebSearch/WebFetch 工具的后端配置）；默认托管档零配置可用。 */
  search: SearchConfig
  settings: {
    ragCandidateLimit: number
    ragContextMaxItems: number
    conversationTokenLimit: number
    compressionKeepRecentTurns: number
    /** Agent 轮次安全阀（模型调用×工具执行的回合数）：0 = 不限；>0 时超限优雅收尾可续接。 */
    agentMaxTurns: number
    /** 写工具权限档位：哪些修改免确认；结构操作除 full 档外一律弹卡。旧配置缺省回填默认档。 */
    permissionPreset: PermissionPreset
    embeddingTextVersion: number
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
