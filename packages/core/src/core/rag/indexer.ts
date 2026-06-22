import { createEmbedding } from '../embedding/client'
import { parseElementFile } from '../elements/parser'
import { readProjectFile } from '../fs/project-fs'
import { hashContent } from '../util/hash'

import type { ProjectSnapshot, TreeNode } from '../../types/project'
import type { IndexedElementDocument, IndexBuildRequest, IndexBuildResult, ProjectIndexMeta } from '../../types/rag'

import { dispatchIndexChange } from './index-events'
import { buildOramaIndex } from './orama-index'
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
    const isFullRebuild = request.reason === 'full-rebuild' || request.reason === 'manual-rebuild' || request.reason === 'initial-build'

    if (isFullRebuild) {
      await store.clearProject(project.id)
    }

    // 预拉旧文档用于 contentHash 短路：按 sourcePath 索引，命中且 hash/model/version
    // 全一致时复用旧 vector，跳过 Embedding 调用。
    // 全量重建已 clear，旧文档为空，短路自然失效（全部重新 embed），逻辑统一。
    const existingDocs = isFullRebuild ? [] : await store.listProjectDocuments(project.id)
    const existingByPath = new Map(existingDocs.map((doc) => [doc.sourcePath, doc]))

    const documents = []
    let embeddingDim = 0
    let skippedCount = 0

    for (const path of elementPaths) {
      const file = await readProjectFile(project, path)
      const contentHash = computeContentHash(file.content)
      const existing = existingByPath.get(path)

      // 短路：内容未变、且 embedding 模型/维度/模板版本一致 → 复用旧向量。
      // 注意 contentHash 口径已对齐 writer 的 normalizeForComparison（排除 updatedAt 行），
      // 因此仅刷新 updatedAt 不会误触发重算。
      if (
        existing
        && existing.contentHash === contentHash
        && existing.embeddingModel === embeddingModel
        && existing.embeddingDim > 0
        && existing.embeddingTextVersion === project.config.settings.embeddingTextVersion
      ) {
        embeddingDim = existing.embeddingDim
        skippedCount += 1

        documents.push({
          ...existing,
          // 这些字段随当前文件状态刷新，即使向量复用
          sourceModifiedAt: file.updatedAt,
          indexedAt: new Date().toISOString(),
        })
        continue
      }

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
        contentHash,
        embeddingProvider,
        embeddingModel,
        embeddingDim: embedding.dimension,
        embeddingTextVersion: project.config.settings.embeddingTextVersion,
      })
    }

    await store.upsertDocuments(documents)

    // 增量场景下清理已删除的要素：旧文档中 sourcePath 不在本次范围的移除。
    // 全量重建已 clear，无需处理。
    if (!isFullRebuild && existingDocs.length > 0) {
      const currentPaths = new Set(elementPaths)
      const removedIds = existingDocs
        .filter((doc) => !currentPaths.has(doc.sourcePath))
        .map((doc) => doc.id)

      if (removedIds.length > 0) {
        await store.removeDocuments(project.id, removedIds)
      }
    }

    // 内存 Orama 索引必须与 IndexedDB 的全量当前状态保持一致：
    // 增量更新时不 clear，IndexedDB 里是「旧 + 本次 upsert」的全集；
    // 全量重建时已 clear，IndexedDB 里就是本次 documents 全集。
    // 因此统一以 upsert 后的 IndexedDB 全量文档重建，避免增量场景下 Orama 丢失其他文档。
    const allDocuments = await store.listProjectDocuments(project.id)
    await buildOramaIndex(project.id, allDocuments)

    const meta: ProjectIndexMeta = {
      projectId: project.id,
      status: allDocuments.length > 0 ? 'ready' : 'empty',
      documentCount: allDocuments.length,
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
    dispatchIndexChange(project.id, meta)

    return {
      projectId: project.id,
      status: meta.status,
      indexedCount: documents.length,
      skippedCount,
      failedCount: 0,
      message:
        allDocuments.length > 0
          ? `索引构建完成，共写入 ${documents.length} 条要素文档${skippedCount > 0 ? `（复用 ${skippedCount} 条未变向量）` : ''}`
          : '索引构建完成，但当前项目下还没有可索引的要素文件',
    }
  } catch (error) {
    const errorMeta: ProjectIndexMeta = {
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
    }
    await store.saveProjectMeta(errorMeta)
    dispatchIndexChange(project.id, errorMeta)

    throw error
  }
}

export async function markProjectIndexStale(
  projectId: string,
  reason: string,
): Promise<void> {
  const store = createRagIndexStore()
  const meta = await store.getProjectMeta(projectId)

  const updatedMeta: ProjectIndexMeta = {
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
  }

  await store.saveProjectMeta(updatedMeta)
  dispatchIndexChange(projectId, updatedMeta)
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

  if (path.startsWith('elements/entities/')) {
    return 'entity' as const
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

/**
 * 计算用于增量比对的内容 hash。
 *
 * 口径与 writer.normalizeForComparison 对齐：把 frontmatter 的 updatedAt 行
 * 归一为固定占位符后再算 hash，这样「只刷新 updatedAt」不会让 contentHash 变化，
 * 避免要素写入时无条件触发 Embedding 重算。
 */
function computeContentHash(content: string) {
  const normalized = content.replace(/^updatedAt: .*$/m, 'updatedAt: <ignored>').trim()
  return hashContent(normalized)
}
