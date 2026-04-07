import { createEmbedding } from '../embedding/client'
import { parseElementFile } from '../elements/parser'
import { readProjectFile } from '../fs/project-fs'

import type { ProjectSnapshot, TreeNode } from '../../types/project'
import type { IndexBuildRequest, IndexBuildResult, ProjectIndexMeta } from '../../types/rag'

import { createRagIndexStore } from './index-store'
import { buildRetrievalText } from './retrieval-text'

export async function getProjectIndexMeta(projectId: string): Promise<ProjectIndexMeta | null> {
  const store = createRagIndexStore()
  return store.getProjectMeta(projectId)
}

export async function buildProjectIndex(
  project: ProjectSnapshot,
  request: IndexBuildRequest,
): Promise<IndexBuildResult> {
  const store = createRagIndexStore()
  const embeddingProvider = project.config.embedding.baseUrl
  const embeddingModel = project.config.embedding.model

  if (!embeddingProvider || !project.config.embedding.apiKey || !embeddingModel) {
    throw new Error('请先完成 Embedding 配置，再执行索引构建')
  }

  await store.saveProjectMeta({
    projectId: project.id,
    status: request.reason === 'full-rebuild' || request.reason === 'manual-rebuild' ? 'rebuilding' : 'building',
    documentCount: 0,
    embeddingProvider,
    embeddingModel,
    embeddingDim: 0,
    embeddingTextVersion: project.config.settings.embeddingTextVersion,
    rerankProvider: project.config.rerank.baseUrl || undefined,
    rerankModel: project.config.rerank.model || undefined,
    lastBuildAt: new Date().toISOString(),
  })

  try {
    const elementPaths = collectElementPaths(project.tree, request.sourcePaths)

    if (request.reason === 'full-rebuild' || request.reason === 'manual-rebuild' || request.reason === 'initial-build') {
      await store.clearProject(project.id)
    }

    const documents = []
    let embeddingDim = 0

    for (const path of elementPaths) {
      const file = await readProjectFile(project, path)
      const parsed = parseElementFile(path, file.content)
      const name = parsed.frontmatter.name || inferNameFromPath(path)
      const type = parsed.frontmatter.type || inferTypeFromPath(path)
      const summary = parsed.frontmatter.summary || summarizeBody(parsed.body)
      const retrievalText = buildRetrievalText({
        ...parsed,
        frontmatter: {
          ...parsed.frontmatter,
          type,
          name,
          summary,
        },
      })

      const embedding = await createEmbedding({
        baseUrl: embeddingProvider,
        apiKey: project.config.embedding.apiKey,
        model: embeddingModel,
        text: retrievalText,
      })

      embeddingDim = embedding.dimension

      documents.push({
        id: parsed.frontmatter.id || createStableElementId(path),
        projectId: project.id,
        sourcePath: path,
        type,
        name,
        summary,
        retrievalText,
        vector: embedding.vector,
        lastUpdatedChapter: parsed.frontmatter.lastUpdatedChapter,
        relatedChapters: parsed.frontmatter.relatedChapters,
        tags: parsed.frontmatter.tags,
        sourceModifiedAt: file.updatedAt,
        indexedAt: new Date().toISOString(),
        contentHash: hashContent(file.content),
        embeddingProvider,
        embeddingModel,
        embeddingDim: embedding.dimension,
        embeddingTextVersion: project.config.settings.embeddingTextVersion,
      })
    }

    await store.upsertDocuments(documents)

    const meta: ProjectIndexMeta = {
      projectId: project.id,
      status: documents.length > 0 ? 'ready' : 'empty',
      documentCount: documents.length,
      embeddingProvider,
      embeddingModel,
      embeddingDim,
      embeddingTextVersion: project.config.settings.embeddingTextVersion,
      rerankProvider: project.config.rerank.baseUrl || undefined,
      rerankModel: project.config.rerank.model || undefined,
      lastBuildAt: new Date().toISOString(),
      lastFullRebuildAt:
        request.reason === 'full-rebuild' || request.reason === 'manual-rebuild'
          ? new Date().toISOString()
          : undefined,
    }

    await store.saveProjectMeta(meta)

    return {
      projectId: project.id,
      status: meta.status,
      indexedCount: documents.length,
      skippedCount: 0,
      failedCount: 0,
      message:
        documents.length > 0
          ? `索引构建完成，共写入 ${documents.length} 条要素文档`
          : '索引构建完成，但当前项目下还没有可索引的要素文件',
    }
  } catch (error) {
    await store.saveProjectMeta({
      projectId: project.id,
      status: 'error',
      documentCount: 0,
      embeddingProvider,
      embeddingModel,
      embeddingDim: 0,
      embeddingTextVersion: project.config.settings.embeddingTextVersion,
      rerankProvider: project.config.rerank.baseUrl || undefined,
      rerankModel: project.config.rerank.model || undefined,
      lastBuildAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : '索引构建失败',
    })

    throw error
  }
}

export async function markProjectIndexStale(
  projectId: string,
  reason: string,
): Promise<void> {
  const store = createRagIndexStore()
  const meta = await store.getProjectMeta(projectId)

  await store.saveProjectMeta({
    projectId,
    status: 'stale',
    documentCount: meta?.documentCount ?? 0,
    embeddingProvider: meta?.embeddingProvider ?? '',
    embeddingModel: meta?.embeddingModel ?? '',
    embeddingDim: meta?.embeddingDim ?? 0,
    embeddingTextVersion: meta?.embeddingTextVersion ?? 1,
    rerankProvider: meta?.rerankProvider,
    rerankModel: meta?.rerankModel,
    lastBuildAt: meta?.lastBuildAt,
    lastFullRebuildAt: meta?.lastFullRebuildAt,
    lastError: reason,
  })
}

function collectElementPaths(tree: TreeNode[], preferredPaths?: string[]) {
  const source = new Set(preferredPaths ?? [])
  const paths: string[] = []
  const stack = [...tree]

  while (stack.length > 0) {
    const node = stack.shift()

    if (!node) {
      continue
    }

    if (node.kind === 'file' && node.path.startsWith('elements/') && node.name.endsWith('.md')) {
      if (source.size === 0 || source.has(node.path)) {
        paths.push(node.path)
      }
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return paths
}

function inferTypeFromPath(path: string) {
  if (path.startsWith('elements/locations/')) {
    return 'location' as const
  }

  if (path.startsWith('elements/timeline/')) {
    return 'timeline' as const
  }

  if (path.startsWith('elements/plots/')) {
    return 'plot' as const
  }

  if (path.startsWith('elements/worldbuilding/')) {
    return 'worldbuilding' as const
  }

  return 'character' as const
}

function inferNameFromPath(path: string) {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? '未命名要素'
}

function summarizeBody(body: string) {
  return body
    .trim()
    .split('\n')
    .find((line) => line.trim())?.trim() ?? ''
}

function createStableElementId(path: string) {
  return `element-${hashContent(path)}`
}

function hashContent(content: string) {
  let hash = 2166136261

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `h${(hash >>> 0).toString(16)}`
}
