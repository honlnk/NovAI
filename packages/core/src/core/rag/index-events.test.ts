import { describe, expect, it } from 'vitest'

import { dispatchIndexChange, onRagIndexChange } from './index-events'

import type { ProjectIndexMeta } from '../../types/rag'

function makeMeta(projectId: string, overrides?: Partial<ProjectIndexMeta>): ProjectIndexMeta {
  return {
    projectId,
    status: 'ready',
    documentCount: 0,
    embeddingProvider: 'p',
    embeddingModel: 'm',
    embeddingDim: 8,
    embeddingTextVersion: 1,
    ...overrides,
  }
}

describe('rag index events', () => {
  it('delivers meta to subscribers of the same project', () => {
    const received: ProjectIndexMeta[] = []
    const unsubscribe = onRagIndexChange('proj-a', (meta) => received.push(meta))

    dispatchIndexChange('proj-a', makeMeta('proj-a', { status: 'stale' }))

    expect(received).toHaveLength(1)
    expect(received[0].status).toBe('stale')

    unsubscribe()
  })

  it('filters out events for other projects', () => {
    const received: ProjectIndexMeta[] = []
    const unsubscribe = onRagIndexChange('proj-a', (meta) => received.push(meta))

    dispatchIndexChange('proj-b', makeMeta('proj-b'))

    expect(received).toHaveLength(0)
    unsubscribe()
  })

  it('stops delivering after unsubscribe', () => {
    const received: ProjectIndexMeta[] = []
    const unsubscribe = onRagIndexChange('proj-a', (meta) => received.push(meta))

    dispatchIndexChange('proj-a', makeMeta('proj-a'))
    unsubscribe()
    dispatchIndexChange('proj-a', makeMeta('proj-a'))

    expect(received).toHaveLength(1)
  })
})
