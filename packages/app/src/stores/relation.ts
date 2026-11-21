import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import {
  RelationConflictError,
  RelationCorruptError,
  cleanupInvalidEntries,
  createRelationEntry,
  deleteRelationEntry,
  getGraph,
  getElementOptions,
  reinitializeLedger,
  saveLayout,
  subscribeRelationChange,
  updateRelationEntry,
} from '@novai/core/services/relation-service'
import type {
  RelationChangeEvent,
  RelationEdgeView,
  RelationElementOptionView,
  RelationGraphView,
} from '@novai/core/services/relation-service'
import type {
  RelationLayoutMap,
  RelationNodeRef,
  RelationRecord,
} from '@novai/core/types/relation'
import type { ElementType } from '@novai/core/types/rag'
import { createSaveSessionRealm } from '../composables/save-session'
import type {
  SaveSessionPhase,
  SaveSessionRestoreRecord,
  SaveSessionSettledResult,
} from '../composables/save-session'
import {
  type PersistedRelationDraftRecord,
  type RelationDraft,
  loadProjectRelationBackups,
  removeRelationBackup,
  scheduleRelationBackup,
} from '../composables/relation-backup'

/**
 * 关系图谱 store（关系图谱施工计划 §六）：
 * - 画布状态：图视图（三态节点解析）、坐标覆盖（拖拽去抖保存）、筛选与聚焦；
 * - 详情编辑：save-session 引擎按关系 id 建会话（两秒自动保存、状态灯、失败补试、
 *   冲突冻结与四出口、切选/关闭立即收口）；
 * - 变更联动：订阅 relation-service 变更通知，Agent 写入触发画布重载（保持视口）
 *   并冻结有未落盘内容的编辑会话；UI 自身写入不回环（现场已同步）。
 */

export type RelationLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'corrupt'

/** 画布节点的渲染摘要（store 产出纯数据，Vue Flow 形状由画布组件映射） */
export type RelationCanvasNode = {
  id: string
  /** 稳定标识（ELM-…） */
  elementId: string
  label: string
  /** 要素类型；幽灵节点（无法解析）为 'ghost' */
  nodeType: ElementType | 'ghost'
  summary: string
  /** 引用解析状态：missing = 要素已删除；ambiguous = 标识重复 */
  status: 'resolved' | 'missing' | 'ambiguous'
  x: number
  y: number
}

export type RelationCanvasEdge = {
  id: string
  fromId: string
  toId: string
  label: string
  description: string
  /** 聚焦模式下是否与焦点节点直接相连（false 时画布降透明度） */
  dimmed: boolean
}

export type RelationNewDraft = {
  fromId: string
  toId: string
  type: string
  description: string
}

/** 关系详情编辑会话（save-session 引擎领域字段） */
type RelationDetailSession = {
  projectId: string
  relationId: string
  draft: RelationDraft
  baseDraft: RelationDraft
  baseContentHash: string
  inFlight: unknown | null
  failure?: { message: string }
  conflict?: import('../composables/save-session').SaveSessionConflictState
  guard?: object
  restoredPending: boolean
  restoredAcked: boolean
  updatedAt: string
}

/** 磁盘版本：关系记录 + 账本内容哈希 */
type RelationDisk = { relation: RelationRecord; contentHash: string }

export const RELATION_TYPE_SUGGESTIONS = [
  '盟友', '敌对', '血缘', '师徒', '隶属', '位于', '暗恋', '合作', '竞争', '守护',
] as const

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function draftOf(relation: RelationRecord): RelationDraft {
  return {
    type: relation.type,
    description: relation.description,
    fromId: relation.from.kind === 'element' ? relation.from.id : '',
    toId: relation.to.kind === 'element' ? relation.to.id : '',
  }
}

function isSameDraft(a: RelationDraft, b: RelationDraft): boolean {
  return a.type === b.type && a.description === b.description && a.fromId === b.fromId && a.toId === b.toId
}

/** 空模板：恢复会话的基线快照（恢复草稿与之相异 → 会话带待写内容，自动保存续存） */
const EMPTY_DRAFT: RelationDraft = { type: '', description: '', fromId: '', toId: '' }

function sameNodeRef(a: RelationNodeRef, b: RelationNodeRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** 默认圆形布局（无保存坐标的节点用；索引稳定，重载不跳位） */
function defaultPosition(index: number, total: number): { x: number; y: number } {
  if (total <= 1) {
    return { x: 320, y: 260 }
  }
  const radius = Math.max(200, total * 45)
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2
  return { x: 360 + Math.cos(angle) * radius, y: 300 + Math.sin(angle) * radius }
}

export const useRelationStore = defineStore('relation', () => {
  /* ---------- 画布状态 ---------- */

  const projectId = ref('')
  const loadState = ref<RelationLoadState>('idle')
  const actionError = ref('')
  const corruptRaw = ref('')
  const graph = shallowRef<RelationGraphView | null>(null)

  const filterRelationType = ref('')
  const filterElementType = ref<ElementType | ''>('')
  const selectedRelationId = ref('')
  const focusedNodeId = ref('')
  /** 搜索添加的节点（有关系节点之外补充上画的要素 id） */
  const extraNodeIds = ref<string[]>([])
  /** 拖拽坐标覆盖（去抖保存前先本地生效；键 = 要素 id） */
  const layoutOverride = ref<RelationLayoutMap>({})

  /** 新建关系表单（空串 = 关闭） */
  const createOpen = ref(false)
  const createDraft = reactive<RelationNewDraft>({ fromId: '', toId: '', type: '', description: '' })
  const createBusy = ref(false)

  const isLoading = computed(() => loadState.value === 'loading')
  const isReady = computed(() => loadState.value === 'ready')
  const isCorrupt = computed(() => loadState.value === 'corrupt')

  const edges = computed<RelationEdgeView[]>(() => {
    const view = graph.value
    if (!view || view.status !== 'ok') {
      return []
    }
    return view.edges
  })

  /** 筛选后的边（关系类型精确匹配；要素类型任一端命中） */
  const visibleEdges = computed<RelationEdgeView[]>(() => {
    const relationType = filterRelationType.value.trim()
    const elementType = filterElementType.value
    return edges.value.filter((edge) => {
      if (relationType && edge.relation.type !== relationType) {
        return false
      }
      if (elementType && edge.from.status !== 'resolved' && edge.to.status !== 'resolved') {
        return false
      }
      if (elementType) {
        const fromHit = edge.from.status === 'resolved' && edge.from.type === elementType
        const toHit = edge.to.status === 'resolved' && edge.to.type === elementType
        if (!fromHit && !toHit) {
          return false
        }
      }
      return true
    })
  })

  /** 聚焦节点的直接相连关系 id 集合（聚焦模式的命中判定） */
  const focusedEdgeIds = computed<Set<string>>(() => {
    const focus = focusedNodeId.value
    const ids = new Set<string>()
    if (!focus) {
      return ids
    }
    for (const edge of visibleEdges.value) {
      if (edge.relation.from.id === focus || edge.relation.to.id === focus) {
        ids.add(edge.relation.id)
      }
    }
    return ids
  })

  /** 画布节点：可见边的端点 + 搜索补充节点；坐标 = 账本 layout ⊕ 拖拽覆盖 ⊕ 默认圆 */
  const canvasNodes = computed<RelationCanvasNode[]>(() => {
    const layout = { ...(graph.value?.layout ?? {}), ...layoutOverride.value }
    const nodes = new Map<string, RelationCanvasNode>()
    for (const edge of visibleEdges.value) {
      for (const node of [edge.from, edge.to]) {
        if (node.status === 'resolved') {
          if (!nodes.has(node.id)) {
            nodes.set(node.id, {
              id: node.id,
              elementId: node.id,
              label: node.name,
              nodeType: node.type,
              summary: node.summary,
              status: 'resolved',
              x: 0,
              y: 0,
            })
          }
        } else if (!nodes.has(node.id)) {
          nodes.set(node.id, {
            id: node.id,
            elementId: node.id,
            label: `未解析 ${node.id}`,
            nodeType: 'ghost',
            summary: node.status === 'ambiguous' ? '标识重复：多个要素占用同一稳定标识' : '要素可能已删除（悬空引用）',
            status: node.status,
            x: 0,
            y: 0,
          })
        }
      }
    }
    // 搜索添加的节点：从未解析的图中找（节点已在图视图解析结果里）
    for (const id of extraNodeIds.value) {
      if (nodes.has(id)) {
        continue
      }
      const hit = edges.value.find(
        (edge) =>
          (edge.from.status !== 'resolved' || edge.to.status !== 'resolved')
          && (edge.from.id === id || edge.to.id === id),
      )
      if (hit) {
        const node = hit.from.id === id ? hit.from : hit.to
        nodes.set(id, {
          id,
          elementId: id,
          label: `未解析 ${id}`,
          nodeType: 'ghost',
          summary: node.status === 'ambiguous' ? '标识重复：多个要素占用同一稳定标识' : '要素可能已删除（悬空引用）',
          status: node.status,
          x: 0,
          y: 0,
        })
        continue
      }
      // 无关系的已解析要素：只有选中项里能拿到完整信息（添加时缓存）
      const cached = extraNodeCache.get(id)
      if (cached) {
        nodes.set(id, { ...cached, x: 0, y: 0 })
      }
    }

    const list = [...nodes.values()]
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id))
    const positioned = list.map((node) => {
      const saved = layout[node.id]
      if (saved) {
        return { ...node, x: saved.x, y: saved.y }
      }
      const index = sorted.findIndex((item) => item.id === node.id)
      const position = defaultPosition(index, sorted.length)
      return { ...node, x: position.x, y: position.y }
    })
    return positioned
  })

  /** 搜索添加的已解析要素信息缓存（无关系时图视图里没有它们） */
  const extraNodeCache = new Map<string, RelationCanvasNode>()

  const canvasEdges = computed<RelationCanvasEdge[]>(() => {
    const focus = focusedNodeId.value
    const focusHits = focusedEdgeIds.value
    return visibleEdges.value.map((edge) => ({
      id: edge.relation.id,
      fromId: edge.relation.from.id,
      toId: edge.relation.to.id,
      label: edge.relation.type,
      description: edge.relation.description,
      dimmed: focus !== '' && !focusHits.has(edge.relation.id),
    }))
  })

  const relationCount = computed(() => edges.value.length)
  const issueCount = computed(() => graph.value?.issues.length ?? 0)

  /** 当前选中的关系边视图 */
  const selectedEdge = computed<RelationEdgeView | null>(
    () => edges.value.find((edge) => edge.relation.id === selectedRelationId.value) ?? null,
  )

  /* ---------- 详情编辑会话（save-session 引擎） ---------- */

  async function probeRelation(pid: string, relationId: string): Promise<
    { kind: 'ok'; disk: RelationDisk } | { kind: 'missing' } | { kind: 'unreadable'; message: string }
  > {
    try {
      const view = await getGraph(pid)
      if (view.status === 'corrupt') {
        return { kind: 'unreadable', message: '关系账本已损坏，无法读取最新版本' }
      }
      const edge = view.edges.find((item) => item.relation.id === relationId)
      if (!edge) {
        return { kind: 'missing' }
      }
      return { kind: 'ok', disk: { relation: edge.relation, contentHash: view.contentHash ?? '' } }
    } catch (error) {
      return { kind: 'unreadable', message: toMessage(error, '读取关系最新版本失败') }
    }
  }

  const detailRealm = createSaveSessionRealm<RelationDetailSession, RelationDraft, RelationDisk>({
    isSameSnapshot: isSameDraft,
    getSnapshot: (session) => session.draft,
    setSnapshot: (session, snapshot) => {
      session.draft = snapshot
    },
    getBaseSnapshot: (session) => session.baseDraft,
    setBaseSnapshot: (session, snapshot) => {
      session.baseDraft = snapshot
    },
    getBaseVersion: (session) => session.baseContentHash,
    setBaseVersion: (session, version) => {
      session.baseContentHash = version
    },
    captureInFlight: (session) => {
      delete session.failure
      return true
    },
    releaseInFlight: (session) => {
      session.inFlight = null
    },
    createSession: (pid, relationId, seed) => ({
      projectId: pid,
      relationId,
      draft: seed.snapshot,
      baseDraft: seed.baseSnapshot,
      baseContentHash: seed.baseVersion ?? '',
      inFlight: null,
      restoredPending: false,
      restoredAcked: false,
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
    }),
    upsertSession: (session, data) => {
      session.draft = data.snapshot
      session.baseDraft = data.baseSnapshot
    },
    save: async (pid, relationId, snapshot, ctx) => {
      try {
        const result = await updateRelationEntry(
          pid,
          {
            id: relationId,
            type: snapshot.type,
            description: snapshot.description,
            from: { kind: 'element', id: snapshot.fromId },
            to: { kind: 'element', id: snapshot.toId },
            // force（冲突出口「采用我的当前内容」）= 不带基线哈希直接写
            ...(ctx.force || ctx.baseVersion === undefined ? {} : { expectedContentHash: ctx.baseVersion }),
          },
          'ui',
        )
        return { ok: true, disk: { relation: result.relation, contentHash: result.contentHash } }
      } catch (error) {
        if (error instanceof RelationConflictError) {
          const probe = await probeRelation(pid, relationId)
          return {
            ok: false,
            conflict: true,
            message: error.message,
            ...(probe.kind === 'ok' ? { disk: probe.disk } : {}),
          }
        }
        return { ok: false, conflict: false, message: toMessage(error, '保存关系失败') }
      }
    },
    probe: (pid, relationId) => probeRelation(pid, relationId),
    versionOf: (disk) => disk.contentHash,
    snapshotFromDisk: (disk) => draftOf(disk.relation),
    isBaselineIntact: (record, disk) => record.baseVersion === disk.contentHash,
    isSnapshotOnDisk: (record, disk) => isSameDraft(record.snapshot, draftOf(disk.relation)),
    scheduleMirror: (session) => {
      scheduleRelationBackup(session.projectId, session.relationId, {
        draft: session.draft,
        baseContentHash: session.baseContentHash,
      })
    },
    removeMirror: (pid, relationId) => {
      removeRelationBackup(pid, relationId)
    },
    onSettled: (pid, relationId, result) => handleDetailSettled(pid, relationId, result),
  })

  detailRealm.setAutosaveInputEnabled(true)

  async function handleDetailSettled(pid: string, relationId: string, result: SaveSessionSettledResult<RelationDisk>): Promise<void> {
    if (pid !== projectId.value) {
      return
    }
    if (result.status === 'saved') {
      actionError.value = ''
      await reloadGraph()
    }
  }

  /** 打开某条关系的编辑会话（已存在则保留草稿；切换前先收口上一条） */
  async function openDetail(relationId: string) {
    const pid = projectId.value
    if (!pid) {
      return
    }
    if (selectedRelationId.value && selectedRelationId.value !== relationId) {
      await detailRealm.flushSession(pid, selectedRelationId.value)
    }
    selectedRelationId.value = relationId
    createOpen.value = false
    if (detailRealm.getSession(pid, relationId)) {
      return
    }
    const edge = edges.value.find((item) => item.relation.id === relationId)
    if (!edge) {
      return
    }
    const draft = draftOf(edge.relation)
    detailRealm.openSession(pid, relationId, {
      snapshot: { ...draft },
      baseSnapshot: { ...draft },
      ...(graph.value?.contentHash !== null && graph.value?.contentHash !== undefined
        ? { baseVersion: graph.value.contentHash }
        : {}),
    })
  }

  /** 编辑输入（自动保存去抖在引擎内） */
  function setDetailDraft(relationId: string, patch: Partial<RelationDraft>) {
    const session = detailRealm.getSession(projectId.value, relationId)
    if (!session) {
      return
    }
    detailRealm.setInput(projectId.value, relationId, { ...session.draft, ...patch })
  }

  /** 关闭当前详情（先收口待写内容） */
  async function closeDetail() {
    const pid = projectId.value
    if (selectedRelationId.value) {
      await detailRealm.flushSession(pid, selectedRelationId.value)
    }
    selectedRelationId.value = ''
  }

  /** 详情会话（当前选中关系的） */
  const detailSession = computed(() => detailRealm.getSession(projectId.value, selectedRelationId.value))

  function detailPhase(session: RelationDetailSession | undefined): SaveSessionPhase {
    return session ? detailRealm.phaseOf(session) : 'clean'
  }

  /** 手动重试（状态条/保存按钮） */
  function retryDetailSave() {
    if (!selectedRelationId.value) {
      return
    }
    void detailRealm.requestSave(projectId.value, selectedRelationId.value, { trigger: 'manual' })
  }

  /** 冲突四出口：①采用磁盘版本（重新读取成功后放弃本地草稿） */
  async function adoptDiskVersion(): Promise<'resolved' | 'probe-failed' | 'aborted'> {
    const key = selectedRelationId.value
    if (!key) {
      return 'probe-failed'
    }
    const outcome = await detailRealm.adoptDisk(projectId.value, key)
    if (outcome === 'resolved') {
      await openDetail(key)
      await reloadGraph()
    }
    return outcome
  }

  /** 冲突四出口：②采用我的当前内容（强写覆盖，二次确认在界面层） */
  async function overwriteWithMine(): Promise<{ ok: boolean; message?: string }> {
    const key = selectedRelationId.value
    if (!key) {
      return { ok: false, message: '当前没有选中的关系' }
    }
    const result = await detailRealm.overwriteContent(projectId.value, key)
    if (result.ok) {
      await reloadGraph()
    }
    return result
  }

  /** 冲突四出口：③返回继续编辑（收起比较，保留双方内容） */
  function collapseConflict() {
    if (selectedRelationId.value) {
      detailRealm.collapseConflict(projectId.value, selectedRelationId.value)
    }
  }

  /** 冲突四出口：④重新读取磁盘（比较区刷新到最新） */
  async function refreshConflict() {
    if (selectedRelationId.value) {
      await detailRealm.expandConflict(projectId.value, selectedRelationId.value)
    }
  }

  /** Agent 写入命中编辑会话：有未落盘内容的会话冻结成冲突（干净会话由重载跟随） */
  async function freezeEditingSessions(): Promise<void> {
    for (const session of detailRealm.listSessions(projectId.value)) {
      await detailRealm.freezeForExternal(projectId.value, session.relationId)
    }
  }

  /* ---------- 图谱读写 ---------- */

  let changeSubscription: (() => void) | null = null

  function handleChange(event: RelationChangeEvent) {
    if (event.projectId !== projectId.value) {
      return
    }
    // UI 自身写入现场已同步，不回环；只响应 Agent 写入（画布重载 + 编辑会话冻结）
    if (event.source !== 'agent') {
      return
    }
    void reloadGraph({ preserveViewport: true }).then(() => {
      if (event.kind !== 'layout') {
        return freezeEditingSessions()
      }
      return undefined
    })
  }

  async function reloadGraph(options: { preserveViewport?: boolean } = {}): Promise<void> {
    const pid = projectId.value
    if (!pid) {
      return
    }
    // 首载走 loading 态（画布显示加载占位）；Agent 写入触发的后台重载保持 ready，
    // 画布继续渲染旧节点、完成后原地换新（不闪加载、不丢视口）
    if (!graph.value && loadState.value !== 'error') {
      loadState.value = 'loading'
    }
    try {
      const view = await getGraph(pid)
      if (pid !== projectId.value) {
        return
      }
      if (view.status === 'corrupt') {
        loadState.value = 'corrupt'
        corruptRaw.value = view.raw ?? ''
        graph.value = null
        return
      }
      corruptRaw.value = ''
      graph.value = view
      loadState.value = 'ready'
      // 悬空引用在 Agent 级联后自动消失：清理已不在图里的选中/聚焦/补充节点
      const knownIds = new Set<string>()
      for (const edge of view.edges) {
        knownIds.add(edge.from.id)
        knownIds.add(edge.to.id)
      }
      if (selectedRelationId.value && !view.edges.some((edge) => edge.relation.id === selectedRelationId.value)) {
        selectedRelationId.value = ''
      }
      if (focusedNodeId.value && !knownIds.has(focusedNodeId.value)) {
        focusedNodeId.value = ''
      }
      extraNodeIds.value = extraNodeIds.value.filter((id) => knownIds.has(id) || extraNodeCache.has(id))
      if (options.preserveViewport !== true) {
        // 首载提示画布 fitView；保持视口的重载不重置
      }
      actionError.value = ''
    } catch (error) {
      if (pid !== projectId.value) {
        return
      }
      loadState.value = 'error'
      actionError.value = toMessage(error, '加载关系图谱失败')
    }
  }

  /** 打开图谱（进入项目时调用；恢复未落盘草稿的会话） */
  async function open(pid: string): Promise<void> {
    if (projectId.value !== pid) {
      projectId.value = pid
      loadState.value = 'idle'
      graph.value = null
      selectedRelationId.value = ''
      focusedNodeId.value = ''
      extraNodeIds.value = []
      layoutOverride.value = {}
      extraNodeCache.clear()
      createOpen.value = false
    }
    if (!changeSubscription) {
      changeSubscription = subscribeRelationChange(handleChange)
    }
    await reloadGraph()
    await restoreDetailSessions(pid)
  }

  /** 关闭图谱（收口全部编辑会话；订阅保留——Agent 写入仍需驱动下次打开时的最新图） */
  async function close(): Promise<void> {
    const pid = projectId.value
    if (pid) {
      await detailRealm.flushSessions(pid)
    }
    createOpen.value = false
  }

  async function restoreDetailSessions(pid: string): Promise<void> {
    const records = loadProjectRelationBackups(pid)
    if (records.length === 0) {
      return
    }
    const restoreRecords: SaveSessionRestoreRecord<RelationDraft>[] = records.map((record) => ({
      key: record.relationId,
      snapshot: { ...record.draft },
      baseSnapshot: { ...EMPTY_DRAFT },
      baseVersion: record.baseContentHash,
      updatedAt: record.updatedAt,
    }))
    // 基线快照取磁盘版本（草稿与会话基线异构，恢复核对按版本令牌）
    await detailRealm.restoreSessions(pid, restoreRecords)
  }

  /* ---------- 写入动作（UI 入口） ---------- */

  /** 搜索添加节点：把无关系的要素补上画布（缓存解析信息供渲染） */
  function addExtraNode(option: RelationElementOptionView): void {
    if (!extraNodeIds.value.includes(option.id)) {
      extraNodeIds.value = [...extraNodeIds.value, option.id]
    }
    extraNodeCache.set(option.id, {
      id: option.id,
      elementId: option.id,
      label: option.name,
      nodeType: option.type,
      summary: option.summary,
      status: 'resolved',
      x: 0,
      y: 0,
    })
  }

  /** 新建关系（新建表单提交） */
  async function submitCreate(): Promise<boolean> {
    const pid = projectId.value
    if (!pid || !createDraft.fromId || !createDraft.toId || !createDraft.type.trim()) {
      actionError.value = '两端节点与关系类型都必填'
      return false
    }
    if (createDraft.fromId === createDraft.toId) {
      actionError.value = '关系的两端不能是同一个对象'
      return false
    }
    createBusy.value = true
    const fromId = createDraft.fromId
    const toId = createDraft.toId
    try {
      const result = await createRelationEntry(
        pid,
        {
          from: { kind: 'element', id: fromId },
          to: { kind: 'element', id: toId },
          type: createDraft.type.trim(),
          ...(createDraft.description.trim() ? { description: createDraft.description.trim() } : {}),
        },
        'ui',
      )
      actionError.value = ''
      createOpen.value = false
      createDraft.fromId = ''
      createDraft.toId = ''
      createDraft.type = ''
      createDraft.description = ''
      // 补充节点已因建关系进入图视图，清出补充列表
      extraNodeIds.value = extraNodeIds.value.filter((id) => id !== fromId && id !== toId)
      await reloadGraph({ preserveViewport: true })
      await openDetail(result.relation.id)
      return true
    } catch (error) {
      actionError.value = toMessage(error, '登记关系失败')
      return false
    } finally {
      createBusy.value = false
    }
  }

  function openCreateForm(): void {
    createOpen.value = true
    selectedRelationId.value = ''
  }

  /** 删除关系（删除确认在界面层） */
  async function removeRelation(relationId: string): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      detailRealm.clearSession(pid, relationId)
      await deleteRelationEntry(pid, relationId, 'ui')
      if (selectedRelationId.value === relationId) {
        selectedRelationId.value = ''
      }
      actionError.value = ''
      await reloadGraph({ preserveViewport: true })
      return true
    } catch (error) {
      actionError.value = toMessage(error, '删除关系失败')
      return false
    }
  }

  /* ---------- 坐标保存（拖拽去抖） ---------- */

  let layoutTimer: ReturnType<typeof setTimeout> | null = null

  function recordNodePosition(nodeId: string, position: { x: number; y: number }): void {
    layoutOverride.value = { ...layoutOverride.value, [nodeId]: { x: position.x, y: position.y } }
    if (layoutTimer) {
      clearTimeout(layoutTimer)
    }
    layoutTimer = setTimeout(() => {
      layoutTimer = null
      void saveLayoutNow()
    }, 800)
  }

  async function saveLayoutNow(): Promise<void> {
    const pid = projectId.value
    if (!pid || Object.keys(layoutOverride.value).length === 0) {
      return
    }
    try {
      const layout: RelationLayoutMap = { ...(graph.value?.layout ?? {}), ...layoutOverride.value }
      await saveLayout(pid, layout, 'ui')
      layoutOverride.value = {}
    } catch (error) {
      // 坐标保存失败不打断画布（重基合并会重试一次；失败提示挂在状态行）
      actionError.value = toMessage(error, '保存画布坐标失败')
    }
  }

  /* ---------- 健康动作 ---------- */

  /** 一键清理异常条目（issue 状态下写入被阻止的出路） */
  async function cleanupIssues(): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      await cleanupInvalidEntries(pid, 'ui')
      actionError.value = ''
      await reloadGraph({ preserveViewport: true })
      return true
    } catch (error) {
      actionError.value = toMessage(error, '清理异常条目失败')
      return false
    }
  }

  /** 损坏态重置：副本入回收站后写空账本（确认在界面层） */
  async function reinitializeFromCorrupt(): Promise<boolean> {
    const pid = projectId.value
    if (!pid) {
      return false
    }
    try {
      await reinitializeLedger(pid, 'ui')
      corruptRaw.value = ''
      actionError.value = ''
      await reloadGraph()
      return true
    } catch (error) {
      actionError.value = toMessage(error, '重新初始化失败')
      return false
    }
  }

  /* ---------- 节点选择器数据 ---------- */

  async function searchElementOptions(query: string, type?: ElementType): Promise<RelationElementOptionView[]> {
    return getElementOptions(projectId.value, query, type || undefined)
  }

  /* ---------- 测试注入口 ---------- */

  function _resetForTest(): void {
    if (changeSubscription) {
      changeSubscription()
      changeSubscription = null
    }
    if (layoutTimer) {
      clearTimeout(layoutTimer)
      layoutTimer = null
    }
    projectId.value = ''
    loadState.value = 'idle'
    graph.value = null
    actionError.value = ''
    corruptRaw.value = ''
    selectedRelationId.value = ''
    focusedNodeId.value = ''
    extraNodeIds.value = []
    layoutOverride.value = {}
    extraNodeCache.clear()
    createOpen.value = false
    detailRealm.resetForTest()
  }

  return {
    // 画布状态
    projectId,
    loadState,
    isLoading,
    isReady,
    isCorrupt,
    actionError,
    corruptRaw,
    graph,
    filterRelationType,
    filterElementType,
    selectedRelationId,
    focusedNodeId,
    edges,
    visibleEdges,
    focusedEdgeIds,
    canvasNodes,
    canvasEdges,
    relationCount,
    issueCount,
    selectedEdge,
    // 生命周期
    open,
    close,
    reloadGraph,
    // 详情编辑
    detailSession,
    detailPhase,
    openDetail,
    setDetailDraft,
    closeDetail,
    retryDetailSave,
    adoptDiskVersion,
    overwriteWithMine,
    collapseConflict,
    refreshConflict,
    // 新建
    createOpen,
    createDraft,
    createBusy,
    openCreateForm,
    submitCreate,
    // 节点与坐标
    addExtraNode,
    recordNodePosition,
    saveLayoutNow,
    searchElementOptions,
    // 健康动作
    removeRelation,
    cleanupIssues,
    reinitializeFromCorrupt,
    // 测试
    _resetForTest,
    _detailRealm: detailRealm,
  }
})
