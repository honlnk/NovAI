import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { RelationChangeEvent, RelationGraphView } from '@novai/core/services/relation-service'
import type { RelationRecord } from '@novai/core/types/relation'
import type { RelationElementOptionView } from '@novai/core/services/relation-service'

/* ---------- relation-service 全量 mock（类型/错误类保留真实实现） ---------- */

const changeListeners = new Set<(event: RelationChangeEvent) => void>()

vi.mock('@novai/core/services/relation-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@novai/core/services/relation-service')>()
  return {
    ...actual,
    getGraph: vi.fn(),
    getElementOptions: vi.fn(),
    createRelationEntry: vi.fn(),
    updateRelationEntry: vi.fn(),
    deleteRelationEntry: vi.fn(),
    saveLayout: vi.fn(),
    cleanupInvalidEntries: vi.fn(),
    reinitializeLedger: vi.fn(),
    subscribeRelationChange: vi.fn((listener: (event: RelationChangeEvent) => void) => {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    }),
  }
})

import {
  RelationConflictError,
  getGraph,
  createRelationEntry,
  updateRelationEntry,
  deleteRelationEntry,
  saveLayout,
  cleanupInvalidEntries,
  reinitializeLedger,
} from '@novai/core/services/relation-service'

/* ---------- 关系草稿备份：内存存储 ---------- */

import {
  type PersistedRelationDraftRecord,
  type RelationBackupStore,
  _resetRelationBackupForTest,
  _setRelationBackupStoreForTest,
} from '../composables/relation-backup'

const memoryStore = new Map<string, PersistedRelationDraftRecord>()

_setRelationBackupStoreForTest({
  put(key, record) {
    memoryStore.set(key, record)
  },
  delete(key) {
    memoryStore.delete(key)
  },
  listByProject(projectId) {
    return [...memoryStore.values()].filter((record) => record.projectId === projectId)
  },
} satisfies RelationBackupStore)

import { useRelationStore } from './relation'

/* ---------- 测试数据 ---------- */

function relation(id: string, overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    id,
    from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
    to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
    type: '盟友',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function graphView(overrides: Partial<RelationGraphView> = {}) {
  return {
    status: 'ok' as const,
    contentHash: 'hash-1',
    layout: {},
    issues: [],
    edges: [
      {
        relation: relation('REL-1111111111'),
        from: {
          status: 'resolved' as const,
          kind: 'element' as const,
          id: 'ELM-aaaaaaaaaa',
          type: 'character' as const,
          name: '林澜',
          summary: '主角',
          sourcePath: 'elements/characters/林澜.md',
        },
        to: {
          status: 'resolved' as const,
          kind: 'element' as const,
          id: 'ELM-bbbbbbbbbb',
          type: 'entity' as const,
          name: '铁剑门',
          summary: '门派',
          sourcePath: 'elements/entities/铁剑门.md',
        },
      },
      {
        relation: relation('REL-2222222222', { type: '悬空', to: { kind: 'element', id: 'ELM-zzzzzzzzzz' } }),
        from: {
          status: 'resolved' as const,
          kind: 'element' as const,
          id: 'ELM-aaaaaaaaaa',
          type: 'character' as const,
          name: '林澜',
          summary: '主角',
          sourcePath: 'elements/characters/林澜.md',
        },
        to: { status: 'missing' as const, kind: 'element' as const, id: 'ELM-zzzzzzzzzz' },
      },
    ],
    ...overrides,
  }
}

vi.mocked(getGraph).mockResolvedValue(graphView())

beforeEach(() => {
  vi.clearAllMocks()
  changeListeners.clear()
  memoryStore.clear()
  _resetRelationBackupForTest()
  vi.mocked(getGraph).mockResolvedValue(graphView())
  vi.mocked(saveLayout).mockResolvedValue({ contentHash: 'hash-2' })
  vi.mocked(updateRelationEntry).mockImplementation(async (_pid: string, options: { id: string; type?: string }) => ({
    relation: relation(options.id, { type: options.type ?? '盟友' }),
    previous: relation(options.id),
    contentHash: 'hash-next',
  }))
  vi.mocked(createRelationEntry).mockImplementation(async () => ({
    relation: relation('REL-new1111111'),
    contentHash: 'hash-new',
    assignedElementIds: [],
    created: true,
  }))
  vi.mocked(deleteRelationEntry).mockResolvedValue({ removed: relation('REL-1111111111'), contentHash: 'hash-after' })
  vi.mocked(cleanupInvalidEntries).mockResolvedValue({ removed: [], contentHash: 'hash-clean' })
  vi.mocked(reinitializeLedger).mockResolvedValue({ trashPath: '.novel/trash/x.json' })
  setActivePinia(createPinia())
})

afterEach(async () => {
  const store = useRelationStore()
  store._resetForTest()
  vi.useRealTimers()
})

function emitChange(event: RelationChangeEvent) {
  for (const listener of [...changeListeners]) {
    listener(event)
  }
}

/* ---------- 画布派生 ---------- */

describe('画布节点与边派生', () => {
  it('open 加载图视图：节点含幽灵（悬空引用）、边带类型；筛选生效', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    expect(store.loadState).toBe('ready')
    expect(store.relationCount).toBe(2)
    expect(store.canvasNodes.map((node) => node.id).sort()).toEqual(['ELM-aaaaaaaaaa', 'ELM-bbbbbbbbbb', 'ELM-zzzzzzzzzz'])
    const ghost = store.canvasNodes.find((node) => node.id === 'ELM-zzzzzzzzzz')!
    expect(ghost.nodeType).toBe('ghost')
    expect(ghost.status).toBe('missing')
    expect(store.canvasEdges).toHaveLength(2)

    store.filterRelationType = '盟友'
    expect(store.visibleEdges).toHaveLength(1)
    store.filterRelationType = ''
    store.filterElementType = 'entity'
    expect(store.visibleEdges).toHaveLength(1)
    expect(store.visibleEdges[0]!.relation.type).toBe('盟友')
    store.filterElementType = ''
  })

  it('聚焦：非直接相连的边降透明', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    store.focusedNodeId = 'ELM-bbbbbbbbbb'
    expect(store.canvasEdges.find((edge) => edge.id === 'REL-1111111111')!.dimmed).toBe(false)
    expect(store.canvasEdges.find((edge) => edge.id === 'REL-2222222222')!.dimmed).toBe(true)
    store.focusedNodeId = ''
  })

  it('坐标：账本 layout 优先，拖拽覆盖叠加，去抖后合并保存', async () => {
    vi.useFakeTimers()
    const store = useRelationStore()
    vi.mocked(getGraph).mockResolvedValue(graphView({ layout: { 'ELM-aaaaaaaaaa': { x: 10, y: 20 } } }))
    await store.open('proj-1')

    const lin = store.canvasNodes.find((node) => node.id === 'ELM-aaaaaaaaaa')!
    expect(lin).toMatchObject({ x: 10, y: 20 })
    const zhou = store.canvasNodes.find((node) => node.id === 'ELM-bbbbbbbbbb')!
    expect(zhou.x).not.toBe(10)

    store.recordNodePosition('ELM-bbbbbbbbbb', { x: 99, y: 88 })
    const overridden = store.canvasNodes.find((node) => node.id === 'ELM-bbbbbbbbbb')!
    expect(overridden).toMatchObject({ x: 99, y: 88 })

    expect(saveLayout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(900)
    await vi.waitFor(() => expect(saveLayout).toHaveBeenCalledTimes(1))
    expect(saveLayout).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        'ELM-aaaaaaaaaa': { x: 10, y: 20 },
        'ELM-bbbbbbbbbb': { x: 99, y: 88 },
      }),
      'ui',
    )
  })
})

/* ---------- Agent 写入联动 ---------- */

describe('变更通知联动', () => {
  it('Agent 写入触发重载并冻结有未落盘内容的编辑会话；UI 写入不回环', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    await store.openDetail('REL-1111111111')
    store.setDetailDraft('REL-1111111111', { type: '决裂' })
    expect(store.detailPhase(store.detailSession)).toBe('pending')

    const callsBefore = vi.mocked(getGraph).mock.calls.length
    emitChange({ projectId: 'proj-1', source: 'ui', kind: 'relations' })
    await Promise.resolve()
    expect(vi.mocked(getGraph).mock.calls.length).toBe(callsBefore)

    emitChange({ projectId: 'proj-1', source: 'agent', kind: 'relations' })
    await vi.waitFor(() => expect(vi.mocked(getGraph).mock.calls.length).toBeGreaterThan(callsBefore))
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())
    expect(store.detailSession?.conflict?.probing).toBe(false)
  })

  it('其他项目的事件不触发本现场', async () => {
    const store = useRelationStore()
    await store.open('proj-1')
    const callsBefore = vi.mocked(getGraph).mock.calls.length

    emitChange({ projectId: 'proj-other', source: 'agent', kind: 'relations' })
    await Promise.resolve()
    expect(vi.mocked(getGraph).mock.calls.length).toBe(callsBefore)
  })
})

/* ---------- 详情编辑会话 ---------- */

describe('详情编辑会话（save-session）', () => {
  it('打开详情建会话；输入走去抖自动保存；切选前收口上一条', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useRelationStore()
    await store.open('proj-1')

    await store.openDetail('REL-1111111111')
    const session = store.detailSession
    expect(session).toBeTruthy()
    expect(session!.draft).toMatchObject({ type: '盟友', fromId: 'ELM-aaaaaaaaaa', toId: 'ELM-bbbbbbbbbb' })

    store.setDetailDraft('REL-1111111111', { description: '林澜与铁剑门共御外敌' })
    expect(updateRelationEntry).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(updateRelationEntry).toHaveBeenCalledTimes(1))
    expect(updateRelationEntry).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'REL-1111111111', description: '林澜与铁剑门共御外敌' }),
      'ui',
    )
  })

  it('版本冲突：会话冻结（conflict）并探测磁盘版本；四出口中的「返回编辑」收起比较', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const store = useRelationStore()
    await store.open('proj-1')
    await store.openDetail('REL-1111111111')

    vi.mocked(updateRelationEntry).mockRejectedValueOnce(new RelationConflictError('hash-disk'))
    store.setDetailDraft('REL-1111111111', { type: '决裂' })
    vi.advanceTimersByTime(2100)
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())
    expect(store.detailPhase(store.detailSession)).toBe('conflict')

    // 冲突携带磁盘版本（probe 结果）
    expect(store.detailSession?.conflict?.disk).toMatchObject({ relation: expect.objectContaining({ id: 'REL-1111111111' }) })

    await store.collapseConflict()
    expect(store.detailSession?.conflict?.expanded).toBe(false)
  })

  it('外部修改命中干净会话：跟随磁盘（不建冲突）；命中待写会话：冻结', async () => {
    const store = useRelationStore()
    await store.open('proj-1')
    await store.openDetail('REL-1111111111')

    // 干净会话 + Agent 改动：只重载，不冲突
    emitChange({ projectId: 'proj-1', source: 'agent', kind: 'relations' })
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeUndefined())

    store.setDetailDraft('REL-1111111111', { type: '决裂' })
    emitChange({ projectId: 'proj-1', source: 'agent', kind: 'relations' })
    await vi.waitFor(() => expect(store.detailSession?.conflict).toBeTruthy())
  })
})

/* ---------- 新建与删除 ---------- */

describe('新建 / 删除 / 健康', () => {
  it('新建校验（缺端点/类型、自环）与成功链路', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    store.openCreateForm()
    expect(store.createOpen).toBe(true)
    expect(await store.submitCreate()).toBe(false)
    expect(store.actionError).toContain('必填')

    store.createDraft.fromId = 'ELM-aaaaaaaaaa'
    store.createDraft.toId = 'ELM-aaaaaaaaaa'
    store.createDraft.type = '盟友'
    expect(await store.submitCreate()).toBe(false)
    expect(store.actionError).toContain('同一个对象')

    store.createDraft.toId = 'ELM-bbbbbbbbbb'
    expect(await store.submitCreate()).toBe(true)
    expect(createRelationEntry).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ from: { kind: 'element', id: 'ELM-aaaaaaaaaa' }, to: { kind: 'element', id: 'ELM-bbbbbbbbbb' }, type: '盟友' }),
      'ui',
    )
    expect(store.createOpen).toBe(false)
    expect(store.selectedRelationId).toBe('REL-new1111111')
  })

  it('删除关系：清会话、清选中、重载', async () => {
    const store = useRelationStore()
    await store.open('proj-1')
    await store.openDetail('REL-1111111111')

    expect(await store.removeRelation('REL-1111111111')).toBe(true)
    expect(deleteRelationEntry).toHaveBeenCalledWith('proj-1', 'REL-1111111111', 'ui')
    expect(store.selectedRelationId).toBe('')
  })

  it('一键清理与损坏重置走服务入口', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    expect(await store.cleanupIssues()).toBe(true)
    expect(cleanupInvalidEntries).toHaveBeenCalledWith('proj-1', 'ui')

    vi.mocked(getGraph).mockResolvedValue({ status: 'corrupt', contentHash: null, edges: [], layout: {}, issues: [], raw: '{ 坏' })
    await store.reloadGraph()
    expect(store.isCorrupt).toBe(true)
    expect(store.corruptRaw).toBe('{ 坏')

    expect(await store.reinitializeFromCorrupt()).toBe(true)
    expect(reinitializeLedger).toHaveBeenCalledWith('proj-1', 'ui')
  })
})

/* ---------- 搜索添加节点 ---------- */

describe('搜索添加节点', () => {
  it('添加无关系要素：节点上画（缓存解析信息）；建关系后移出补充列表', async () => {
    const store = useRelationStore()
    await store.open('proj-1')

    const option: RelationElementOptionView = {
      id: 'ELM-cccccccccc',
      type: 'location',
      name: '青云山',
      summary: '门派所在',
      sourcePath: 'elements/locations/青云山.md',
    }
    store.addExtraNode(option)
    expect(store.canvasNodes.some((node) => node.id === 'ELM-cccccccccc' && node.label === '青云山')).toBe(true)

    // 图刷新后补充节点仍保留（缓存仍在）
    await store.reloadGraph({ preserveViewport: true })
    expect(store.canvasNodes.some((node) => node.id === 'ELM-cccccccccc')).toBe(true)

    // 建立涉及该节点的关系：create 落账、图视图带新边返回，节点改由图视图呈现（补充列表清空）
    const created = relation('REL-new1111111', {
      type: '位于',
      from: { kind: 'element', id: 'ELM-cccccccccc' },
      to: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
    })
    vi.mocked(createRelationEntry).mockResolvedValueOnce({
      relation: created,
      contentHash: 'hash-new',
      assignedElementIds: [],
      created: true,
    })
    vi.mocked(getGraph).mockImplementationOnce(async () =>
      graphView({
        edges: [
          ...graphView().edges,
          {
            relation: created,
            from: { status: 'resolved', kind: 'element', id: 'ELM-cccccccccc', type: 'location', name: '青云山', summary: '门派所在', sourcePath: 'elements/locations/青云山.md' },
            to: { status: 'resolved', kind: 'element', id: 'ELM-aaaaaaaaaa', type: 'character', name: '林澜', summary: '主角', sourcePath: 'elements/characters/林澜.md' },
          },
        ],
      }),
    )
    store.openCreateForm()
    store.createDraft.fromId = 'ELM-cccccccccc'
    store.createDraft.toId = 'ELM-aaaaaaaaaa'
    store.createDraft.type = '位于'
    await store.submitCreate()
    expect(store.canvasNodes.filter((node) => node.id === 'ELM-cccccccccc').length).toBe(1)
    expect(store.canvasNodes.some((node) => node.id === 'ELM-cccccccccc' && node.label === '青云山')).toBe(true)
  })
})

/* ---------- 恢复镜像 ---------- */

describe('恢复镜像回填', () => {
  it('浏览器刷新后未落盘草稿回填为待写会话', async () => {
    memoryStore.set('novai-relation-draft:["proj-1","REL-1111111111"]', {
      projectId: 'proj-1',
      relationId: 'REL-1111111111',
      draft: { type: '决裂', description: '草稿', fromId: 'ELM-aaaaaaaaaa', toId: 'ELM-bbbbbbbbbb' },
      baseContentHash: 'hash-1',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const store = useRelationStore()
    await store.open('proj-1')

    const session = store._detailRealm.getSession('proj-1', 'REL-1111111111')
    expect(session).toBeTruthy()
    expect(session!.draft.type).toBe('决裂')
    expect(store._detailRealm.isDirty(session!)).toBe(true)
  })
})
