import { afterEach, describe, expect, it, vi } from 'vitest'

// 懒构建路径会读取 IndexedDB，node 测试环境没有 indexedDB。
// mock 成本：让 listProjectDocuments 返回空，懒构建读到空 → getOramaIndex 返回 null → 空召回。
vi.mock('./index-store', () => ({
  createRagIndexStore: () => ({
    listProjectDocuments: async () => [],
  }),
}))

import { buildOramaIndex, dropOramaIndex, searchOrama } from './orama-index'

import type { IndexedElementDocument, RetrievalQuery } from '../../types/rag'

const PROJECT_ID = 'proj-test'

afterEach(() => {
  // 注册表是模块级单例，每个用例后清空避免互相污染。
  dropOramaIndex(PROJECT_ID)
})

function makeDocument(overrides: Partial<IndexedElementDocument> & Pick<IndexedElementDocument, 'id' | 'name' | 'vector'>): IndexedElementDocument {
  return {
    projectId: PROJECT_ID,
    sourcePath: `elements/characters/${overrides.id}.md`,
    type: 'character',
    summary: overrides.name,
    retrievalText: overrides.name,
    tags: [],
    lastUpdatedChapter: '',
    relatedChapters: [],
    sourceModifiedAt: '',
    indexedAt: '',
    contentHash: '',
    embeddingProvider: '',
    embeddingModel: '',
    embeddingDim: overrides.vector.length,
    embeddingTextVersion: 1,
    ...overrides,
  } as IndexedElementDocument
}

function makeQuery(vector: number[], overrides?: Partial<RetrievalQuery>): RetrievalQuery {
  return {
    projectId: PROJECT_ID,
    query: '测试查询',
    topK: 10,
    ...overrides,
  }
}

describe('orama-index buildOramaIndex + searchOrama', () => {
  it('returns empty result when no index has been built', async () => {
    // 未构建任何索引（registry 为空），不应抛错，直接空召回。
    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0]), [1, 0, 0])

    expect(result.candidates).toEqual([])
    expect(result.total).toBe(0)
  })

  it('recalls documents ranked by vector similarity', async () => {
    // 三个文档向量方向不同，查询向量与第二个最接近。
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '远离', vector: [0, 0, 1] }),
      makeDocument({ id: 'b', name: '命中', vector: [1, 0, 0] }),
      makeDocument({ id: 'c', name: '中间', vector: [0, 1, 0] }),
    ])

    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0], { topK: 10 }), [1, 0, 0])

    expect(result.total).toBe(3)
    expect(result.candidates[0].id).toBe('b')
    expect(result.candidates[0].score).toBeGreaterThan(0)
  })

  it('respects topK limit', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0] }),
      makeDocument({ id: 'b', name: '二', vector: [0.9, 0.1, 0] }),
      makeDocument({ id: 'c', name: '三', vector: [0, 1, 0] }),
    ])

    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0], { topK: 2 }), [1, 0, 0])

    expect(result.candidates).toHaveLength(2)
  })

  it('filters by element type', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'char', name: '人物', vector: [1, 0, 0], type: 'character' }),
      makeDocument({ id: 'loc', name: '地点', vector: [1, 0, 0], type: 'location', sourcePath: 'elements/locations/loc.md' }),
    ])

    const result = await searchOrama(
      PROJECT_ID,
      makeQuery([1, 0, 0], { filters: { type: ['location'] } }),
      [1, 0, 0],
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('loc')
  })

  it('filters by lastUpdatedChapter', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0], lastUpdatedChapter: '第001章' }),
      makeDocument({ id: 'b', name: '二', vector: [1, 0, 0], lastUpdatedChapter: '第002章' }),
    ])

    const result = await searchOrama(
      PROJECT_ID,
      makeQuery([1, 0, 0], { filters: { lastUpdatedChapter: '第002章' } }),
      [1, 0, 0],
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('b')
  })

  it('filters by tags (matches if any document tag overlaps)', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0], tags: ['主角', '剑修'] }),
      makeDocument({ id: 'b', name: '二', vector: [1, 0, 0], tags: ['反派'] }),
    ])

    const result = await searchOrama(
      PROJECT_ID,
      makeQuery([1, 0, 0], { filters: { tags: ['主角'] } }),
      [1, 0, 0],
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('a')
  })

  it('rebuild does not leak old documents', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'old', name: '旧', vector: [1, 0, 0] }),
    ])

    // 用全新的文档集合重建，旧文档不应残留。
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'new', name: '新', vector: [1, 0, 0] }),
    ])

    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0]), [1, 0, 0])

    expect(result.total).toBe(1)
    expect(result.candidates[0].id).toBe('new')
  })

  it('building with empty documents drops the index and yields empty recall', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0] }),
    ])

    await buildOramaIndex(PROJECT_ID, [])

    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0]), [1, 0, 0])

    expect(result.candidates).toEqual([])
  })

  it('returns empty recall when query vector dimension mismatches index', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0] }),
    ])

    // 索引是 3 维，查询给 2 维：维度不匹配，降级为空召回而不是抛错。
    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0], { topK: 10 }), [1, 0])

    expect(result.candidates).toEqual([])
  })

  it('dropOramaIndex clears an existing index', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument({ id: 'a', name: '一', vector: [1, 0, 0] }),
    ])

    dropOramaIndex(PROJECT_ID)

    const result = await searchOrama(PROJECT_ID, makeQuery([1, 0, 0]), [1, 0, 0])

    expect(result.candidates).toEqual([])
  })
})
