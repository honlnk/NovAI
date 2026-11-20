import { checkRelationLedger, type RelationNodeSelector } from '../relation/store'
import { countDiffLines } from './file-tools/diff-line-stats'
import { asRecord, readString } from './file-tools/common'
import {
  createRelationEntry,
  deleteRelationEntry,
  getGraph,
  updateRelationEntry,
} from '../../services/relation-service'
import { RELATION_LEDGER_PATH } from '../../types/relation'
import type {
  RelationCheckInput,
  RelationCheckOutput,
  RelationCreateInput,
  RelationCreateOutput,
  RelationDeleteInput,
  RelationDeleteOutput,
  RelationListInput,
  RelationListOutput,
  RelationNodeInput,
  RelationNodeSummary,
  RelationQueryInput,
  RelationQueryOutput,
  RelationReadInput,
  RelationReadOutput,
  RelationSummaryItem,
  RelationUpdateInput,
  RelationUpdateOutput,
  ToolDefinition,
} from './types'

/**
 * 关系图谱智能体工具（关系图谱施工计划 §五）。主 Agent 专属，要素管理员不装配
 * （与伏笔/节奏工具同一先例）。写入经关系服务层（域内写锁 + 版本校验 + 变更通知，
 * source='agent' 让画布刷新），并走 AI 写入确认链（buildConfirmation）与
 * 变更账本（extractFileChange / extractChangeDiff）。
 */

const RELATION_LIST_LIMIT = 50

const CORRUPT_MESSAGE = '关系账本文件已损坏，读取与写入都被阻止；请提醒作者在关系图谱弹窗中查看原始内容或重新初始化'

/* ---------- 入参解析 ---------- */

const NODE_INPUT_TYPES = ['character', 'location', 'entity', 'plot', 'worldbuilding'] as const

function isNodeInputType(value: string): value is (typeof NODE_INPUT_TYPES)[number] {
  return (NODE_INPUT_TYPES as readonly string[]).includes(value)
}

/** 节点定位入参：稳定标识或「类型 + 精确名称」二选一（都给时以标识优先）。 */
function readNodeSelector(value: unknown, label: string): RelationNodeSelector {
  const record = asRecord(value)
  const kind = record.kind === undefined ? 'element' : record.kind
  if (kind !== 'element') {
    throw new Error(`${label}.kind 第一版只支持 element；事件引用等时间线事件账本上线后开放`)
  }

  const id = record.id === undefined ? undefined : readString(record.id, `${label}.id`).trim()
  if (id) {
    return { kind: 'element', id }
  }

  const type = record.type === undefined ? undefined : readString(record.type, `${label}.type`).trim()
  const name = record.name === undefined ? undefined : readString(record.name, `${label}.name`).trim()
  if (type !== undefined || name !== undefined) {
    if (!type || !name) {
      throw new Error(`${label} 按「类型 + 名称」定位时 type 与 name 都必须提供；已有稳定标识则传 id 即可`)
    }
    if (!isNodeInputType(type)) {
      throw new Error(`${label}.type 必须是 ${NODE_INPUT_TYPES.join(' / ')} 之一（旧时间线要素不是关系节点）`)
    }
    return { kind: 'element', type, name }
  }

  throw new Error(`${label} 必须提供 id（稳定标识）或 type + name（类型与精确名称）之一`)
}

/* ---------- 输出摘要 ---------- */

type GraphView = Awaited<ReturnType<typeof getGraph>>
type NodeView = GraphView['edges'][number]['from']

function toNodeSummary(node: NodeView): RelationNodeSummary {
  return {
    kind: node.kind,
    id: node.id,
    name: node.status === 'resolved' ? node.name : '',
    type: node.status === 'resolved' ? node.type : '',
  }
}

/** 把图视图边映射为模型友好的摘要条目（端点解析失败仍带 id，名称留空）。 */
function toSummaryItem(edge: GraphView['edges'][number]): RelationSummaryItem {
  return {
    id: edge.relation.id,
    from: toNodeSummary(edge.from),
    to: toNodeSummary(edge.to),
    type: edge.relation.type,
    description: edge.relation.description,
    updatedAt: edge.relation.updatedAt,
  }
}

/** 端点 id → 摘要映射（写工具渲染输出用；只收已解析节点）。 */
function nameMapFromGraph(graph: GraphView): Map<string, RelationNodeSummary> {
  const map = new Map<string, RelationNodeSummary>()
  if (graph.status !== 'ok') {
    return map
  }
  for (const edge of graph.edges) {
    for (const node of [edge.from, edge.to]) {
      if (node.status === 'resolved' && !map.has(node.id)) {
        map.set(node.id, { kind: node.kind, id: node.id, name: node.name, type: node.type })
      }
    }
  }
  return map
}

function unresolvedSummary(id: string, kind: 'element' | 'event'): RelationNodeSummary {
  return { kind, id, name: '', type: '' }
}

function describeSelectorNode(node: RelationNodeInput): string {
  if (node.id) {
    return node.id
  }
  if (node.type && node.name) {
    return `${node.name}（${node.type}）`
  }
  return '未定位的节点'
}

function listGuidance(totalCount: number): string {
  return totalCount > 0
    ? `共 ${totalCount} 条关系。写人物对手戏前建议用 RelationQuery 只取相关人物之间的关系，避免整账本进上下文`
    : '账本还没有关系。登记用 RelationCreate；写到人物互动、势力归属时先登记再写作，正文与关系账本互为印证'
}

function truncateRelations(relations: readonly RelationSummaryItem[]): { items: RelationSummaryItem[]; truncated: boolean } {
  if (relations.length <= RELATION_LIST_LIMIT) {
    return { items: [...relations], truncated: false }
  }
  return { items: relations.slice(0, RELATION_LIST_LIMIT), truncated: true }
}

/* ---------- 只读工具 ---------- */

export const relationListTool: ToolDefinition<'RelationList', RelationListInput, RelationListOutput> = {
  name: 'RelationList',
  description: '列出项目关系账本中的关系，可按要素类型或关系类型筛选。返回带两端要素名称与类型的摘要。',
  validateInput(input) {
    const value = asRecord(input)
    const elementType = value.elementType === undefined ? undefined : readString(value.elementType, 'RelationList.elementType').trim()
    if (elementType !== undefined && !isNodeInputType(elementType)) {
      throw new Error(`RelationList.elementType 必须是 ${NODE_INPUT_TYPES.join(' / ')} 之一`)
    }
    const relationType = value.relationType === undefined ? undefined : readString(value.relationType, 'RelationList.relationType').trim()
    return {
      ...(elementType !== undefined ? { elementType } : {}),
      ...(relationType !== undefined ? { relationType } : {}),
    }
  },
  async run(input, runtime) {
    const graph = await getGraph(runtime.project.id)
    if (graph.status === 'corrupt') {
      throw new Error(CORRUPT_MESSAGE)
    }

    let edges = graph.edges
    const elementType = input.elementType
    if (elementType !== undefined) {
      edges = edges.filter(
        (edge) =>
          (edge.from.status === 'resolved' && edge.from.type === elementType)
          || (edge.to.status === 'resolved' && edge.to.type === elementType),
      )
    }
    const relationType = input.relationType
    if (relationType !== undefined) {
      edges = edges.filter((edge) => edge.relation.type === relationType)
    }

    const items = edges.map(toSummaryItem)
    const { items: limited, truncated } = truncateRelations(items)
    return {
      relations: limited,
      totalCount: items.length,
      truncated,
      guidance: listGuidance(items.length) + (truncated ? `；仅返回前 ${RELATION_LIST_LIMIT} 条，可加筛选条件缩小范围` : ''),
    }
  },
  summarizeInput(input) {
    const parts = [
      input.elementType ? `要素类型=${input.elementType}` : '',
      input.relationType ? `关系类型=${input.relationType}` : '',
    ].filter(Boolean)
    return `列出关系账本${parts.length > 0 ? `（${parts.join('，')}）` : ''}`
  },
  summarizeOutput(output) {
    return `账本共 ${output.totalCount} 条关系${output.truncated ? `，返回前 ${output.relations.length} 条` : ''}`
  },
}

export const relationReadTool: ToolDefinition<'RelationRead', RelationReadInput, RelationReadOutput> = {
  name: 'RelationRead',
  description: '按稳定标识读取一条关系的完整内容（两端要素、方向、类型、描述与登记时间）。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RelationRead.id').trim()
    if (!id) {
      throw new Error('RelationRead.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const graph = await getGraph(runtime.project.id)
    if (graph.status === 'corrupt') {
      throw new Error(CORRUPT_MESSAGE)
    }

    const edge = graph.edges.find((item) => item.relation.id === input.id)
    if (!edge) {
      return { notFound: true as const, id: input.id }
    }

    const unresolved = [edge.from, edge.to].filter((node) => node.status !== 'resolved')
    return {
      id: edge.relation.id,
      from: toNodeSummary(edge.from),
      to: toNodeSummary(edge.to),
      type: edge.relation.type,
      description: edge.relation.description,
      createdAt: edge.relation.createdAt,
      updatedAt: edge.relation.updatedAt,
      resolutionNote: unresolved.length > 0
        ? '有端点无法解析（要素可能已删除或标识重复）；建议 RelationCheck 检查并按提示处理'
        : '',
    }
  },
  summarizeInput(input) {
    return `读取关系 ${input.id}`
  },
  summarizeOutput(output) {
    return 'notFound' in output
      ? `关系 ${output.id} 不存在`
      : `已读取关系 ${output.id}（${output.from.name || output.from.id} → ${output.to.name || output.to.id}，${output.type}）`
  },
}

export const relationQueryTool: ToolDefinition<'RelationQuery', RelationQueryInput, RelationQueryOutput> = {
  name: 'RelationQuery',
  description: '面向创作意图的关系查询：传 elementId 返回与该要素直接相连的全部关系；传 elementIds（如当前场景出场人物）返回两端都在集合内的关系。写人物对手戏、势力归属前先用它拿既有关系，不要凭记忆编。',
  validateInput(input) {
    const value = asRecord(input)
    const elementId = value.elementId === undefined ? undefined : readString(value.elementId, 'RelationQuery.elementId').trim()
    const elementIds = value.elementIds === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.elementIds)) {
            throw new Error('RelationQuery.elementIds 必须是字符串数组')
          }
          const ids = value.elementIds.map((item, index) => readString(item, `RelationQuery.elementIds[${index}]`).trim())
          if (ids.some((id) => !id)) {
            throw new Error('RelationQuery.elementIds 不能包含空标识')
          }
          return ids
        })()

    if (elementId !== undefined && elementIds !== undefined) {
      throw new Error('RelationQuery 的 elementId 与 elementIds 只能二选一：查单个对象用 elementId，查一组对象（如当前场景人物）用 elementIds')
    }
    if (elementId === undefined && elementIds === undefined) {
      throw new Error('RelationQuery 必须提供 elementId（单个要素）或 elementIds（一组要素）之一')
    }
    if (elementId !== undefined && !elementId) {
      throw new Error('RelationQuery.elementId 不能为空')
    }
    if (elementIds !== undefined && elementIds.length < 1) {
      throw new Error('RelationQuery.elementIds 至少包含一个标识')
    }
    return {
      ...(elementId !== undefined ? { elementId } : {}),
      ...(elementIds !== undefined ? { elementIds } : {}),
    }
  },
  async run(input, runtime) {
    const graph = await getGraph(runtime.project.id)
    if (graph.status === 'corrupt') {
      throw new Error(CORRUPT_MESSAGE)
    }

    let edges = graph.edges
    const elementId = input.elementId
    const elementIds = input.elementIds
    if (elementId !== undefined) {
      edges = edges.filter(
        (edge) =>
          (edge.relation.from.kind === 'element' && edge.relation.from.id === elementId)
          || (edge.relation.to.kind === 'element' && edge.relation.to.id === elementId),
      )
    } else if (elementIds !== undefined) {
      const idSet = new Set(elementIds)
      edges = edges.filter(
        (edge) =>
          edge.relation.from.kind === 'element' && idSet.has(edge.relation.from.id)
          && edge.relation.to.kind === 'element' && idSet.has(edge.relation.to.id),
      )
    }

    const items = edges.map(toSummaryItem)
    const { items: limited, truncated } = truncateRelations(items)
    const scope = elementId !== undefined ? '该对象' : '这组对象之间'
    return {
      relations: limited,
      totalCount: items.length,
      truncated,
      guidance: items.length > 0
        ? `${scope}共 ${items.length} 条已登记关系${truncated ? `，仅返回前 ${RELATION_LIST_LIMIT} 条` : ''}；方向按 from → to 读`
        : `${scope}还没有登记任何关系。若正文已体现明确关系，建议用 RelationCreate 登记`,
    }
  },
  summarizeInput(input) {
    return input.elementId !== undefined
      ? `查询要素 ${input.elementId} 的关系`
      : `查询 ${input.elementIds?.length ?? 0} 个对象之间的关系`
  },
  summarizeOutput(output) {
    return `命中 ${output.totalCount} 条关系`
  },
}

export const relationCheckTool: ToolDefinition<'RelationCheck', RelationCheckInput, RelationCheckOutput> = {
  name: 'RelationCheck',
  description: '检查关系账本数据健康：格式非法条目、重复关系、悬空引用（要素已删除）、标识重复与旧时间线要素误用。报告问题并给出处理建议。',
  validateInput(input) {
    asRecord(input)
    return {}
  },
  async run(_input, runtime) {
    const { issues } = await checkRelationLedger(runtime.project)
    const rendered = issues.map((issue) => {
      switch (issue.kind) {
        case 'invalid-relation':
          return { kind: issue.kind, detail: `格式非法的关系条目：第 ${issue.index + 1} 条，${issue.reason}` }
        case 'invalid-layout-entry':
          return { kind: issue.kind, detail: `格式非法的画布坐标：坐标键 ${issue.key}，${issue.reason}` }
        case 'duplicate-relation':
          return { kind: issue.kind, detail: `重复关系：${issue.id} 与 ${issue.duplicateOf} 重复（同向同类型 ${issue.type}），删除其中一条` }
        case 'dangling-reference':
          return { kind: issue.kind, detail: `悬空引用：关系 ${issue.relationId} 的${issue.endpoint === 'from' ? '起点' : '终点'} ${issue.id} 找不到要素（可能已删除），删除该关系或重建要素` }
        case 'ambiguous-reference':
          return { kind: issue.kind, detail: `标识重复：关系 ${issue.relationId} 的${issue.endpoint === 'from' ? '起点' : '终点'} ${issue.id} 对应多个要素（${issue.sourcePaths.join('、')}），先在要素库修正重复标识` }
        case 'timeline-node':
          return { kind: issue.kind, detail: `误用旧时间线要素：关系 ${issue.relationId} 的${issue.endpoint === 'from' ? '起点' : '终点'}引用了「${issue.name}」；请改用其他类型要素作节点` }
        case 'event-reference-unsupported':
          return { kind: issue.kind, detail: `事件引用：关系 ${issue.relationId} 的${issue.endpoint === 'from' ? '起点' : '终点'}引用了事件 ${issue.id}，事件账本未上线，请先移除` }
      }
    })

    return {
      ok: issues.length === 0,
      issues: rendered,
      totalCount: issues.length,
      guidance: issues.length === 0
        ? '账本数据健康：无重复、无悬空引用、无非法条目'
        : '以上问题可在关系图谱弹窗中处理：悬空/误用条目可删除后重建，重复标识需先在要素库修正；格式非法条目会阻止账本写入',
    }
  },
  summarizeInput() {
    return '检查关系账本数据'
  },
  summarizeOutput(output) {
    return output.ok ? '账本数据健康' : `发现 ${output.totalCount} 个问题`
  },
}

/* ---------- 写入工具 ---------- */

export const relationCreateTool: ToolDefinition<'RelationCreate', RelationCreateInput, RelationCreateOutput> = {
  name: 'RelationCreate',
  description: '登记一条有向关系。两端用稳定标识（id）或「类型 + 精确名称」定位；type 用短词（如 盟友/血缘/隶属/位于），细腻语义写 description。同一方向同一类型只登记一条；反向是独立条目。',
  validateInput(input) {
    const value = asRecord(input)
    const from = readNodeSelector(value.from, 'RelationCreate.from')
    const to = readNodeSelector(value.to, 'RelationCreate.to')
    const type = readString(value.type, 'RelationCreate.type').trim()
    if (!type) {
      throw new Error('RelationCreate.type 不能为空；用简短词概括关系（如 盟友、血缘、隶属）')
    }
    const description = value.description === undefined ? undefined : readString(value.description, 'RelationCreate.description')
    return {
      from,
      to,
      type,
      ...(description !== undefined ? { description } : {}),
    }
  },
  async run(input, runtime) {
    const from = readNodeSelector(input.from, 'RelationCreate.from')
    const to = readNodeSelector(input.to, 'RelationCreate.to')
    const result = await createRelationEntry(
      runtime.project.id,
      {
        from,
        to,
        type: input.type,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      'agent',
    )

    // 写入后重读图：新关系与懒分配的标识此时都已可解析
    const graph = await getGraph(runtime.project.id)
    const names = nameMapFromGraph(graph)
    const diff = countDiffLines('', JSON.stringify(result.relation, null, 2))

    return {
      id: result.relation.id,
      from: names.get(result.relation.from.id) ?? unresolvedSummary(result.relation.from.id, result.relation.from.kind),
      to: names.get(result.relation.to.id) ?? unresolvedSummary(result.relation.to.id, result.relation.to.kind),
      type: result.relation.type,
      description: result.relation.description,
      created: result.created,
      sourcePath: RELATION_LEDGER_PATH,
      assignedElementIds: result.assignedElementIds,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    return `登记关系 ${describeSelectorNode(input.from)} → ${describeSelectorNode(input.to)}（${input.type}）`
  },
  summarizeOutput(output) {
    const assigned = output.assignedElementIds.length > 0
      ? `；为 ${output.assignedElementIds.length} 个要素首次分配了稳定标识`
      : ''
    return `已登记关系 ${output.id}（${output.from.name || output.from.id} → ${output.to.name || output.to.id}，${output.type}）${assigned}`
  },
  extractFileChange(output) {
    return output.created
      ? { type: 'created' as const, path: RELATION_LEDGER_PATH }
      : { type: 'updated' as const, path: RELATION_LEDGER_PATH }
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: JSON.stringify({ id: output.id, from: output.from, to: output.to, type: output.type, description: output.description }, null, 2),
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    return {
      kind: 'create' as const,
      path: `${RELATION_LEDGER_PATH}（关系账本）`,
      content: [
        `新增关系：${describeSelectorNode(input.from)} → ${describeSelectorNode(input.to)}`,
        `类型：${input.type}`,
        `描述：${input.description?.trim() || '（未登记）'}`,
      ].join('\n'),
    }
  },
}

export const relationUpdateTool: ToolDefinition<'RelationUpdate', RelationUpdateInput, RelationUpdateOutput> = {
  name: 'RelationUpdate',
  description: '按稳定标识修改一条关系：类型、描述或两端（改端点会重新校验引用与重复）。至少提供一项。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RelationUpdate.id').trim()
    if (!id) {
      throw new Error('RelationUpdate.id 不能为空')
    }
    const type = value.type === undefined ? undefined : readString(value.type, 'RelationUpdate.type').trim()
    if (type !== undefined && !type) {
      throw new Error('RelationUpdate.type 不能传空串；要修改请给新短词')
    }
    const description = value.description === undefined ? undefined : readString(value.description, 'RelationUpdate.description')
    const from = value.from === undefined ? undefined : readNodeSelector(value.from, 'RelationUpdate.from')
    const to = value.to === undefined ? undefined : readNodeSelector(value.to, 'RelationUpdate.to')
    if (type === undefined && description === undefined && from === undefined && to === undefined) {
      throw new Error('RelationUpdate 至少提供 type、description、from、to 中要修改的一项')
    }
    return {
      id,
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    }
  },
  async run(input, runtime) {
    const result = await updateRelationEntry(
      runtime.project.id,
      {
        id: input.id,
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.from !== undefined ? { from: readNodeSelector(input.from, 'RelationUpdate.from') } : {}),
        ...(input.to !== undefined ? { to: readNodeSelector(input.to, 'RelationUpdate.to') } : {}),
      },
      'agent',
    )

    const graph = await getGraph(runtime.project.id)
    const names = nameMapFromGraph(graph)
    const diff = countDiffLines(JSON.stringify(result.previous, null, 2), JSON.stringify(result.relation, null, 2))

    return {
      id: result.relation.id,
      from: names.get(result.relation.from.id) ?? unresolvedSummary(result.relation.from.id, result.relation.from.kind),
      to: names.get(result.relation.to.id) ?? unresolvedSummary(result.relation.to.id, result.relation.to.kind),
      type: result.relation.type,
      description: result.relation.description,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    const parts = [
      input.type !== undefined ? `类型→${input.type}` : '',
      input.description !== undefined ? '描述' : '',
      input.from !== undefined ? '起点' : '',
      input.to !== undefined ? '终点' : '',
    ].filter(Boolean)
    return `修改关系 ${input.id}（${parts.join('，')}）`
  },
  summarizeOutput(output) {
    return `已修改关系 ${output.id}（${output.from.name || output.from.id} → ${output.to.name || output.to.id}，${output.type}）`
  },
  extractFileChange() {
    return { type: 'updated' as const, path: RELATION_LEDGER_PATH }
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: JSON.stringify({ id: output.id, from: output.from, to: output.to, type: output.type, description: output.description }, null, 2),
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    const parts = [
      input.type !== undefined ? `类型 → ${input.type}` : '',
      input.description !== undefined ? `描述 → ${input.description.trim() || '（清空）'}` : '',
      input.from !== undefined ? `起点 → ${describeSelectorNode(input.from)}` : '',
      input.to !== undefined ? `终点 → ${describeSelectorNode(input.to)}` : '',
    ].filter(Boolean)
    return {
      kind: 'edit' as const,
      path: `${RELATION_LEDGER_PATH}（关系 ${input.id}）`,
      oldText: '（关系字段更新，差异以执行结果为准）',
      newText: parts.join('\n'),
    }
  },
}

export const relationDeleteTool: ToolDefinition<'RelationDelete', RelationDeleteInput, RelationDeleteOutput> = {
  name: 'RelationDelete',
  description: '按稳定标识删除一条关系。只在关系登记错误或用户明确要求时使用；关系已不成立本身也构成删除理由（账本登记当前事实）。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RelationDelete.id').trim()
    if (!id) {
      throw new Error('RelationDelete.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    // 先读图拿端点名称（删除后引用索引里可能就查不到了）
    const graph = await getGraph(runtime.project.id)
    if (graph.status === 'corrupt') {
      throw new Error(CORRUPT_MESSAGE)
    }
    const edge = graph.edges.find((item) => item.relation.id === input.id)
    const fromName = edge && edge.from.status === 'resolved' ? edge.from.name : ''
    const toName = edge && edge.to.status === 'resolved' ? edge.to.name : ''

    const result = await deleteRelationEntry(runtime.project.id, input.id, 'agent')
    const diff = countDiffLines(JSON.stringify(result.removed, null, 2), '')

    return {
      id: result.removed.id,
      type: result.removed.type,
      fromName: fromName || result.removed.from.id,
      toName: toName || result.removed.to.id,
      linesAdded: 0,
      linesRemoved: diff.linesRemoved,
    }
  },
  summarizeInput(input) {
    return `删除关系 ${input.id}`
  },
  summarizeOutput(output) {
    return `已删除关系 ${output.id}（${output.fromName} → ${output.toName}，${output.type}）`
  },
  extractFileChange() {
    return { type: 'updated' as const, path: RELATION_LEDGER_PATH }
  },
  extractChangeDiff(output) {
    return {
      oldText: JSON.stringify({ id: output.id, type: output.type, from: output.fromName, to: output.toName }, null, 2),
      newText: '',
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  buildConfirmation(input) {
    return {
      kind: 'delete' as const,
      path: `${RELATION_LEDGER_PATH}（关系 ${input.id}）`,
    }
  },
}
