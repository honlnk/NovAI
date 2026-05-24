export type ProjectSummary = {
  id: string
  name: string
  updatedAt: string
  chapterCount: number
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
