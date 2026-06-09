export const DEFAULT_SYSTEM_PROMPT = `# SYSTEM Prompt

在这里定义整部小说的基调、叙事视角、文风偏好与创作约束。

## 文件格式约定
- 章节正文写入 chapters/*.txt，正文使用纯文本。
- 章节文件第一行写章节标题，例如：第001章 章节标题。
- 章节正文不要使用 Markdown 标题、列表、引用、分割线等格式符号。
- 人物、地点、实体、情节、时间线、世界观等要素写入 elements/**/*.md。
- SYSTEM 与 SCENE 提示词写入 prompts/**/*.md。`

export const DEFAULT_SCENE_PROMPT = `# Scene Prompt

在这里为具体章节记录本场景目标、冲突、登场人物与氛围。`

export const DEFAULT_CONFIG = {
  version: 1,
  project: {
    name: '',
    createdAt: '',
    updatedAt: '',
  },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  embedding: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  rerank: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    mode: 'text',
    topN: 8,
  },
  settings: {
    generationRecentChapters: 3,
    ragCandidateLimit: 20,
    ragContextMaxItems: 8,
    proofreadDefaultChapters: 3,
    organizeDefaultChapters: 10,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
    embeddingTextVersion: 1,
    enableBackgroundIndexing: true,
    enableDebugLogging: false,
  },
} as const

export function createDefaultConfig(projectName: string) {
  const now = new Date().toISOString()

  return {
    ...DEFAULT_CONFIG,
    project: {
      name: projectName,
      createdAt: now,
      updatedAt: now,
    },
  }
}

export function createDefaultManifest(projectId: string) {
  const now = new Date().toISOString()

  return {
    version: 1,
    projectId,
    createdAt: now,
    lastOpenedAt: now,
  }
}
