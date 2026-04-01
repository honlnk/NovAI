export const DEFAULT_SYSTEM_PROMPT = `# SYSTEM Prompt

在这里定义整部小说的基调、叙事视角、文风偏好与创作约束。`

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
  settings: {
    generationRecentChapters: 3,
    ragCandidateLimit: 20,
    proofreadDefaultChapters: 3,
    organizeDefaultChapters: 10,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
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
