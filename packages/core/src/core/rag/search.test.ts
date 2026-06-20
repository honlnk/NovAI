import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 空索引场景下 searchRagCandidates 会触发懒构建（读 IndexedDB），
// node 测试环境没有 indexedDB，mock 成空列表让懒构建返回 null。
vi.mock('./index-store', () => ({
  createRagIndexStore: () => ({
    listProjectDocuments: async () => [],
  }),
}))

import { buildOramaIndex, dropOramaIndex } from './orama-index'
import { searchRagCandidates } from './search'

import type { ProjectConfig } from '../../types/project'
import type { IndexedElementDocument } from '../../types/rag'

const PROJECT_ID = 'proj-search-test'

// 用一个稳定可区分的查询向量构造 embedding 响应。
// 这些向量不经过真实模型，只用于验证召回链路：查询向量与文档向量的几何关系决定排序。
const QUERY_VECTOR = [1, 0, 0]

function mockEmbeddingFetch() {
  const fetchMock = (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {}
    const url = typeof input === 'string' ? input : input.toString()

    if (url.endsWith('/embeddings')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: QUERY_VECTOR, index: 0 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }

    return Promise.resolve(new Response('{}', { status: 200 }))
  }

  globalThis.fetch = fetchMock as typeof globalThis.fetch
}

function makeConfig(): ProjectConfig {
  return {
    embedding: {
      baseUrl: 'https://embed.example.com',
      apiKey: 'test-key',
      model: 'test-embed',
    },
  } as ProjectConfig
}

function makeDocument(id: string, vector: number[]): IndexedElementDocument {
  return {
    id,
    projectId: PROJECT_ID,
    sourcePath: `elements/characters/${id}.md`,
    type: 'character',
    name: id,
    summary: id,
    retrievalText: id,
    vector,
    tags: [],
    lastUpdatedChapter: '',
    relatedChapters: [],
    sourceModifiedAt: '',
    indexedAt: '',
    contentHash: '',
    embeddingProvider: '',
    embeddingModel: '',
    embeddingDim: vector.length,
    embeddingTextVersion: 1,
  } as IndexedElementDocument
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  mockEmbeddingFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dropOramaIndex(PROJECT_ID)
})

describe('searchRagCandidates', () => {
  it('returns empty result when no index exists', async () => {
    const result = await searchRagCandidates(
      { projectId: PROJECT_ID, query: '查询', topK: 10 },
      makeConfig(),
    )

    expect(result.candidates).toEqual([])
    expect(result.total).toBe(0)
  })

  it('returns ranked candidates from the Orama index', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument('near', QUERY_VECTOR),
      makeDocument('far', [0, 1, 0]),
    ])

    const result = await searchRagCandidates(
      { projectId: PROJECT_ID, query: '查询', topK: 10 },
      makeConfig(),
    )

    expect(result.total).toBe(2)
    expect(result.candidates[0].id).toBe('near')
  })

  it('respects topK', async () => {
    await buildOramaIndex(PROJECT_ID, [
      makeDocument('a', QUERY_VECTOR),
      makeDocument('b', QUERY_VECTOR),
      makeDocument('c', QUERY_VECTOR),
    ])

    const result = await searchRagCandidates(
      { projectId: PROJECT_ID, query: '查询', topK: 2 },
      makeConfig(),
    )

    expect(result.candidates).toHaveLength(2)
  })

  it('passes type filter through to Orama', async () => {
    await buildOramaIndex(PROJECT_ID, [
      { ...makeDocument('char', QUERY_VECTOR), type: 'character' },
      { ...makeDocument('loc', QUERY_VECTOR), type: 'location', sourcePath: 'elements/locations/loc.md' },
    ])

    const result = await searchRagCandidates(
      { projectId: PROJECT_ID, query: '查询', topK: 10, filters: { type: ['character'] } },
      makeConfig(),
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].id).toBe('char')
  })

  it('carries score on each candidate', async () => {
    await buildOramaIndex(PROJECT_ID, [makeDocument('a', QUERY_VECTOR)])

    const result = await searchRagCandidates(
      { projectId: PROJECT_ID, query: '查询', topK: 10 },
      makeConfig(),
    )

    expect(result.candidates[0].score).toBeGreaterThan(0)
  })
})
