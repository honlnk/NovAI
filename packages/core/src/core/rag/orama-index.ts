import {
  create,
  insertMultiple,
  MODE_VECTOR_SEARCH,
  searchVector,
  type AnyOrama,
  type AnySchema,
} from '@orama/orama'

import type {
  IndexedElementDocument,
  RetrievalCandidate,
  RetrievalQuery,
  RetrievalResult,
} from '../../types/rag'

import { createRagIndexStore } from './index-store'

/**
 * Orama 内存索引注册表。
 *
 * 每个 projectId 对应一个常驻内存的 Orama 实例，负责该项目的向量相似度召回。
 * IndexedDB 仍然是跨会话的真实持久层；Orama 实例只是「当前会话内的可重建缓存」，
 * 在索引构建后填充，查询时零成本复用。
 *
 * 设计依据见 docs/architecture/向量索引与重排序设计.md「四、Orama 召回策略」。
 */

const VECTOR_PROPERTY = 'embedding'

type OramaRegistryEntry = {
  /** Orama 实例。schema 在构建时根据首条可用向量维度动态确定。 */
  db: AnyOrama
  documentCount: number
  /** 记录 build 时的向量维度，用于校验后续查询向量是否兼容。 */
  vectorDimension: number
}

const registry = new Map<string, OramaRegistryEntry>()

/**
 * 用一批已落盘的要素文档构建（或重建）某个项目的内存 Orama 索引。
 *
 * 传入的 documents 必须已包含向量（来自 Embedding 模型）。空列表会清除旧实例，
 * 让该项目的后续查询走空召回，而不是带着过期数据继续返回。
 */
export async function buildOramaIndex(
  projectId: string,
  documents: IndexedElementDocument[],
): Promise<void> {
  // 重建语义：先丢弃旧实例，避免旧文档残留进新索引。
  registry.delete(projectId)

  if (documents.length === 0) {
    return
  }

  const vectorDimension = documents[0]?.vector.length ?? 0
  if (vectorDimension === 0) {
    // 没有可用向量说明数据不完整，不要建立空壳索引。
    return
  }

  const db = await create({
    schema: {
      id: 'string',
      sourcePath: 'string',
      type: 'string',
      name: 'string',
      summary: 'string',
      retrievalText: 'string',
      tags: 'string[]',
      lastUpdatedChapter: 'string',
      relatedChapters: 'string[]',
      [VECTOR_PROPERTY]: `vector[${vectorDimension}]`,
    } as AnySchema,
  })

  await insertMultiple(
    db,
    documents.map((document) => ({
      id: document.id,
      sourcePath: document.sourcePath,
      type: document.type,
      name: document.name,
      summary: document.summary,
      retrievalText: document.retrievalText,
      tags: document.tags,
      lastUpdatedChapter: document.lastUpdatedChapter,
      relatedChapters: document.relatedChapters,
      [VECTOR_PROPERTY]: document.vector,
    })),
  )

  registry.set(projectId, {
    db,
    documentCount: documents.length,
    vectorDimension,
  })
}

/**
 * 取得某个项目的内存 Orama 实例；不存在时从 IndexedDB 懒构建。
 *
 * 懒构建用于「会话首次查询、但本次尚未触发显式 build」的情况——例如用户直接
 * 打开一个已有旧索引的项目就开始对话。读到 IndexedDB 文档即灌入 Orama。
 */
export async function getOramaIndex(projectId: string): Promise<AnyOrama | null> {
  const entry = registry.get(projectId)
  if (entry) {
    return entry.db
  }

  // 内存里没有，尝试从 IndexedDB 重建。空项目直接返回 null，调用方据此走空召回。
  const store = createRagIndexStore()
  const documents = await store.listProjectDocuments(projectId)

  if (documents.length === 0) {
    return null
  }

  await buildOramaIndex(projectId, documents)
  return registry.get(projectId)?.db ?? null
}

/**
 * 清除某个项目的内存 Orama 实例。
 *
 * 用于全量重建（旧索引不可信）与项目关闭/删除（释放内存）。
 * 不会删除 IndexedDB 中的持久数据。
 */
export function dropOramaIndex(projectId: string): void {
  registry.delete(projectId)
}

/**
 * 在某个项目的 Orama 索引上执行向量召回，返回与现有 RetrievalResult 兼容的结构。
 *
 * 过滤条件（type / tags / lastUpdatedChapter）翻译为 Orama where 子句。
 * tags 在 schema 中声明为 string[]，Orama where 对其按「包含任一标签」匹配；
 * 为稳妥起见，命中后再做一次本地校验，避免不同 Orama 版本语义差异带来误召回。
 */
export async function searchOrama(
  projectId: string,
  query: RetrievalQuery,
  queryVector: number[],
): Promise<RetrievalResult> {
  const db = await getOramaIndex(projectId)

  if (!db) {
    return {
      query: query.query,
      candidates: [],
      total: 0,
    }
  }

  const entry = registry.get(projectId)
  if (entry && queryVector.length !== entry.vectorDimension) {
    // 查询向量维度与索引维度不一致（通常是 Embedding 模型切换后未重建），
    // 直接返回空召回而不是抛错，让上层走「无上下文」兜底，避免阻塞生成。
    return {
      query: query.query,
      candidates: [],
      total: 0,
    }
  }

  // 过滤策略：
  // - type / lastUpdatedChapter 是稳定标量（ASCII 或受控取值），交给 Orama where 精确过滤。
  // - tags 是用户自由文本（常含中文），Orama 的 where 基于 tokenizer 分词，中文会被切成
  //   单字 token 导致匹配不稳定。因此 tags 不进 where，而是让 Orama 多召回，再用本地
  //   精确匹配兜底。为避免 topK 截断掉本应被本地保留的候选，带 tags 时放大召回上限。
  const where = buildWhereClause(query)
  const needsLocalTagFilter = !!query.filters?.tags?.length
  const recallLimit = needsLocalTagFilter ? Math.max(query.topK * 4, query.topK) : query.topK

  const results = await searchVector(db, {
    mode: MODE_VECTOR_SEARCH,
    vector: {
      value: queryVector,
      property: VECTOR_PROPERTY,
    },
    similarity: 0,
    where,
    limit: recallLimit,
  })

  const candidates: RetrievalCandidate[] = []
  for (const hit of results.hits) {
    const document = hit.document as OramaHitDocument
    if (!matchesFilters(document, query)) {
      continue
    }

    candidates.push({
      id: document.id,
      projectId,
      sourcePath: document.sourcePath,
      type: document.type,
      name: document.name,
      summary: document.summary,
      retrievalText: document.retrievalText,
      tags: document.tags,
      lastUpdatedChapter: document.lastUpdatedChapter,
      relatedChapters: document.relatedChapters,
      score: hit.score,
    })

    if (candidates.length >= query.topK) {
      break
    }
  }

  return {
    query: query.query,
    candidates,
    total: candidates.length,
  }
}

type OramaHitDocument = {
  id: string
  sourcePath: string
  type: RetrievalCandidate['type']
  name: string
  summary: string
  retrievalText: string
  tags: string[]
  lastUpdatedChapter: string
  relatedChapters: string[]
}

function buildWhereClause(query: RetrievalQuery) {
  const filters = query.filters
  if (!filters) {
    return undefined
  }

  const clauses: Record<string, unknown> = {}

  if (filters.type?.length) {
    clauses.type = filters.type
  }

  if (filters.lastUpdatedChapter) {
    clauses.lastUpdatedChapter = filters.lastUpdatedChapter
  }

  // tags 不放入 where：中文 tag 经 tokenizer 分词后匹配不稳定，改由本地 matchesFilters 兜底。
  return Object.keys(clauses).length > 0 ? clauses : undefined
}

function matchesFilters(
  document: { type: RetrievalCandidate['type']; tags: string[]; lastUpdatedChapter: string },
  query: RetrievalQuery,
) {
  if (query.filters?.type?.length && !query.filters.type.includes(document.type)) {
    return false
  }

  if (query.filters?.tags?.length && !query.filters.tags.some((tag) => document.tags.includes(tag))) {
    return false
  }

  if (query.filters?.lastUpdatedChapter && query.filters.lastUpdatedChapter !== document.lastUpdatedChapter) {
    return false
  }

  return true
}
