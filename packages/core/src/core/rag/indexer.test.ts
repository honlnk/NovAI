import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * indexer.ts 的 contentHash 增量短路与删除清理是纯逻辑，
 * 但它依赖 IndexedDB（index-store）、Embedding（fetch）、项目文件系统（project-fs）。
 * 这里全部 mock，用一个内存 store 观察写入/删除行为，并断言 createEmbedding 的调用次数。
 */

// 内存 store：记录 upsert / remove / meta，供断言。
type StoredDoc = import('../../types/rag').IndexedElementDocument

const storeState = {
  meta: null as import('../../types/rag').ProjectIndexMeta | null,
  docs: new Map<string, StoredDoc>(),
  upsertCount: 0,
  removeCount: 0,
}

vi.mock('./index-store', () => ({
  createRagIndexStore: () => ({
    async getProjectMeta() {
      return storeState.meta
    },
    async saveProjectMeta(meta: import('../../types/rag').ProjectIndexMeta) {
      storeState.meta = meta
    },
    async listProjectDocuments() {
      return Array.from(storeState.docs.values())
    },
    async upsertDocuments(docs: StoredDoc[]) {
      storeState.upsertCount += 1
      for (const doc of docs) {
        storeState.docs.set(`${doc.projectId}::${doc.id}`, doc)
      }
    },
    async removeDocuments(_projectId: string, ids: string[]) {
      storeState.removeCount += ids.length
      for (const id of ids) {
        for (const [key, doc] of storeState.docs) {
          if (doc.id === id) {
            storeState.docs.delete(key)
          }
        }
      }
    },
    async clearProject(projectId: string) {
      for (const key of [...storeState.docs.keys()]) {
        if (key.startsWith(`${projectId}::`)) {
          storeState.docs.delete(key)
        }
      }
    },
  }),
}))

// mock project-fs：用测试注入的文件内容映射。
const files = new Map<string, { content: string; updatedAt: string }>()
vi.mock('../fs/project-fs', () => ({
  async readProjectFile(_project: unknown, path: string) {
    const file = files.get(path)
    if (!file) {
      throw new Error(`测试未提供文件: ${path}`)
    }
    return { content: file.content, updatedAt: file.updatedAt }
  },
}))

// mock embedding client：记录调用次数，返回可区分向量。
const embeddingCalls: string[] = []
vi.mock('../embedding/client', () => ({
  async createEmbedding({ text }: { text: string }) {
    embeddingCalls.push(text)
    // 用文本长度伪造一个稳定可区分的向量，保证不同文本向量不同。
    const vector = [text.length, text.length * 2, text.length * 3]
    return { vector, dimension: 3 }
  },
}))

import { buildProjectIndex } from './indexer'

import type { ProjectSnapshot } from '../../types/project'
import type { IndexedElementDocument } from '../../types/rag'

const PROJECT_ID = 'proj-indexer'

const baseConfig = {
  embedding: {
    baseUrl: 'https://embed.test',
    apiKey: 'key',
    model: 'embed-model',
  },
  rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', mode: 'text' as const, topN: 8 },
  settings: { ragCandidateLimit: 20, ragContextMaxItems: 8, embeddingTextVersion: 1 },
} as ProjectSnapshot['config']

function makeProject(tree: ProjectSnapshot['tree']): ProjectSnapshot {
  return {
    id: PROJECT_ID,
    handle: {} as ProjectSnapshot['handle'],
    config: baseConfig,
    tree,
  } as ProjectSnapshot
}

function fileNode(path: string): ProjectSnapshot['tree'][number] {
  return { kind: 'file', name: path.split('/').pop()!, path, updatedAt: '' }
}

function elementMd(path: string, name: string, body = '正文内容'): string {
  return `---\nname: ${name}\ntype: character\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`
}

function seedDoc(overrides: Partial<IndexedElementDocument> & Pick<IndexedElementDocument, 'id' | 'sourcePath'>): IndexedElementDocument {
  return {
    projectId: PROJECT_ID,
    type: 'character',
    name: overrides.id,
    summary: '',
    retrievalText: '',
    vector: [9, 9, 9],
    tags: [],
    lastUpdatedChapter: '',
    relatedChapters: [],
    sourceModifiedAt: '',
    indexedAt: '',
    contentHash: '',
    embeddingProvider: 'https://embed.test',
    embeddingModel: 'embed-model',
    embeddingDim: 3,
    embeddingTextVersion: 1,
    ...overrides,
  }
}

beforeEach(() => {
  storeState.meta = null
  storeState.docs.clear()
  storeState.upsertCount = 0
  storeState.removeCount = 0
  files.clear()
  embeddingCalls.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildProjectIndex contentHash 增量短路', () => {
  it('全量重建：所有文件都调 Embedding，不短路', async () => {
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲'), updatedAt: '' })
    files.set('elements/characters/b.md', { content: elementMd('elements/characters/b.md', '乙'), updatedAt: '' })

    const result = await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md'), fileNode('elements/characters/b.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    expect(embeddingCalls).toHaveLength(2)
    expect(result.indexedCount).toBe(2)
    expect(result.skippedCount).toBe(0)
  })

  it('增量重建：未变文件复用旧向量，不调 Embedding', async () => {
    // 先全量建一次，拿到 contentHash
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲'), updatedAt: '' })
    files.set('elements/characters/b.md', { content: elementMd('elements/characters/b.md', '乙'), updatedAt: '' })

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md'), fileNode('elements/characters/b.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    const docsAfterFirstBuild = Array.from(storeState.docs.values())
    expect(docsAfterFirstBuild).toHaveLength(2)
    const firstCallCount = embeddingCalls.length
    expect(firstCallCount).toBe(2)

    // 再次增量：内容完全不变，应全部短路。
    embeddingCalls.length = 0
    const result = await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md'), fileNode('elements/characters/b.md')]),
      { projectId: PROJECT_ID, reason: 'incremental-update' },
    )

    expect(embeddingCalls).toHaveLength(0)
    expect(result.skippedCount).toBe(2)
    expect(result.indexedCount).toBe(2)
  })

  it('仅刷新 updatedAt 不触发重算（hash 口径排除 updatedAt 行）', async () => {
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲'), updatedAt: '' })

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    // 改动 updatedAt 行，正文不变。
    files.set('elements/characters/a.md', {
      content: `---\nname: 甲\ntype: character\nupdatedAt: 2026-12-31T00:00:00.000Z\n---\n\n正文内容\n`,
      updatedAt: '',
    })

    embeddingCalls.length = 0
    const result = await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'incremental-update' },
    )

    expect(embeddingCalls).toHaveLength(0)
    expect(result.skippedCount).toBe(1)
  })

  it('正文变化时重新 Embedding', async () => {
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲', '旧正文'), updatedAt: '' })

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲', '全新的正文'), updatedAt: '' })

    embeddingCalls.length = 0
    const result = await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'incremental-update' },
    )

    expect(embeddingCalls).toHaveLength(1)
    expect(result.skippedCount).toBe(0)
    expect(result.indexedCount).toBe(1)
  })

  it('embedding 模型变化时即使内容相同也重算', async () => {
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲'), updatedAt: '' })

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    // 模拟旧文档是用旧模型索引的（与新配置 model 不同）。
    for (const doc of storeState.docs.values()) {
      doc.embeddingModel = 'old-model'
    }

    embeddingCalls.length = 0
    const result = await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md')]),
      { projectId: PROJECT_ID, reason: 'incremental-update' },
    )

    expect(embeddingCalls).toHaveLength(1)
    expect(result.skippedCount).toBe(0)
  })

  it('增量清理已删除的要素（旧文档不在新范围）', async () => {
    files.set('elements/characters/a.md', { content: elementMd('elements/characters/a.md', '甲'), updatedAt: '' })
    files.set('elements/characters/b.md', { content: elementMd('elements/characters/b.md', '乙'), updatedAt: '' })

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md'), fileNode('elements/characters/b.md')]),
      { projectId: PROJECT_ID, reason: 'manual-rebuild' },
    )

    // 手动 seed 一个「已被删除的要素」旧文档（文件树里不再有它）。
    storeState.docs.set(
      `${PROJECT_ID}::gone`,
      seedDoc({ id: 'gone', sourcePath: 'elements/characters/gone.md' }),
    )
    expect(storeState.docs.size).toBe(3)

    await buildProjectIndex(
      makeProject([fileNode('elements/characters/a.md'), fileNode('elements/characters/b.md')]),
      { projectId: PROJECT_ID, reason: 'incremental-update' },
    )

    // gone 文档应被清理。
    expect(storeState.docs.has(`${PROJECT_ID}::gone`)).toBe(false)
    expect(storeState.removeCount).toBe(1)
  })
})
