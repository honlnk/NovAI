import type { ModelProtocol, ReasoningEffort } from './ai'

/**
 * 写工具权限档位：review=仅审阅 / chapter=章节内容 / material=素材内容 /
 * chapter-material=章节+素材（默认） / full=完全访问。
 * 判定规则见 core/agent/permission.ts。
 */
export type PermissionPreset = 'review' | 'chapter' | 'material' | 'chapter-material' | 'full'

/**
 * 园丁专用权限档位（Phase 2 计划 D3 裁剪三档）：园丁被路径闸限制只能写 elements/，
 * 五档中「章节档」对它效果等同「仅审阅」（elements 改动照样全弹卡），故裁剪。
 * 值域落在 PermissionPreset 内，判定复用 decideWriteToolPermission，无独立分支。
 */
export type GardenerPermissionPreset = Extract<PermissionPreset, 'review' | 'material' | 'full'>

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
     * LLM 服务的 API 协议。四种协议的生成链路均已接入
     * （core/llm/protocol/ 适配器），openai / anthropic 已经真机验证，
     * gemini / openai-responses 真机待 key。
     */
    protocol: ModelProtocol
    /**
     * 思考强度档位（输入框选择器写回，四档）。未配置 = 请求层按 'off' 解析（默认关闭，
     * 2026-09-24 拍板移除 'default' 档）；零迁移：旧项目无此字段自动落到关闭。
     * 压缩摘要/要素提取等辅助请求不读它（固定关思考）。
     */
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
  /**
   * 园丁子代理覆盖配置（《要素园丁 Phase 2 施工计划》D2-D5）。
   * 整块可选：无此块 = 全继承主 Agent 当前配置——每次委派时动态取主配置当时值
   * （按次取值、运行中定格）；normalize 不主动写入，仅用户在设置页开启覆盖时落盘。
   */
  gardener?: {
    /**
     * 未定义 = 继承主 Agent llm。整组覆盖（协议+地址+key+模型+思考档），不拆字段混搭；
     * 残缺块由 normalize 整体剔除回退继承，防半覆盖拼出无效组合。
     */
    llm?: {
      baseUrl: string
      apiKey: string
      model: string
      protocol: ModelProtocol
      /** 未定义 = 继承主 Agent 当前思考档（整理是高认知负荷任务，常配更强模型/更高档，D4）。 */
      reasoningEffort?: ReasoningEffort
    }
    /** 未定义 = 继承 settings.permissionPreset；只接受三档（D3）。 */
    permissionPreset?: GardenerPermissionPreset
  }
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
     * 当前激活的写作大纲路径（相对于项目根，如 prompts/outlines/outline-001.md）。
     * 留空时不附加任何大纲；已激活时随最新 user 消息动态附带，切换/关闭当轮即生效
     * （W2 注入机制 + W3 改名迁移；旧配置 activeScenePromptPath 读取时自动映射）。
     */
    activeOutlinePath: string | null
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
  | 'missing-prompts-outlines'
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
