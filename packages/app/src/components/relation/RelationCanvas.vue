<script setup lang="ts">
/**
 * 关系画布（关系图谱施工计划 §六）：Vue Flow 渲染关系图。
 * - 节点：store 产出的纯数据（RelationCanvasNode）映射为自定义 relation 节点
 *   （名称 + 类型 + 摘要，按要素类型着色；幽灵节点灰虚线）；坐标由 store 决定；
 * - 边：有向箭头、标签为关系类型、平行关系自动偏移；聚焦模式下非直接相连降透明；
 * - 交互：节点可拖（拖停回传坐标去抖保存）、点击节点聚焦、点击边开详情；
 * - 样式在组件内引入（不动全局 CSS 入口）。
 */
import { computed } from 'vue'
import { Handle, MarkerType, Position, VueFlow, useVueFlow } from '@vue-flow/core'
import type { Edge, Node } from '@vue-flow/core'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

import type { RelationCanvasEdge, RelationCanvasNode } from '../../stores/relation'

const props = defineProps<{
  nodes: RelationCanvasNode[]
  edges: RelationCanvasEdge[]
  selectedEdgeId: string
  focusNodeId: string
}>()

const emit = defineEmits<{
  /** 拖拽停止：回传节点最新坐标（父层去抖保存） */
  dragStop: [nodeId: string, position: { x: number; y: number }]
  /** 点击节点：聚焦其直接关系 */
  nodeClick: [nodeId: string]
  /** 点击边：打开关系详情 */
  edgeClick: [relationId: string]
  /** 空白点击：取消聚焦/选中 */
  paneClick: []
}>()

/** 节点类型着色（边框与圆点；幽灵节点灰） */
const TYPE_COLORS: Record<string, string> = {
  character: '#3b82f6',
  location: '#10b981',
  entity: '#8b5cf6',
  plot: '#f59e0b',
  worldbuilding: '#14b8a6',
  ghost: '#9ca3af',
}

const TYPE_LABELS: Record<string, string> = {
  character: '人物',
  location: '地点',
  entity: '实体',
  plot: '情节',
  worldbuilding: '世界观',
  ghost: '未解析',
}

interface RelationNodeData extends Record<string, unknown> {
  label: string
  nodeType: string
  summary: string
  status: 'resolved' | 'missing' | 'ambiguous'
  dimmed: boolean
  /** 该节点需要的手柄槽位数（参与的任一节点对的最大平行边数，至少 1） */
  parallelSlots: number
}

/** 平行关系分槽：同一对节点的多条边按序占不同手柄槽位，曲线扇形偏移不重叠 */
const parallel = computed(() => {
  const nodeSlots = new Map<string, number>()
  const edgeSlot = new Map<string, number>()
  const pairIndex = new Map<string, number>()
  for (const edge of props.edges) {
    const key = `${edge.fromId}→${edge.toId}`
    const slot = pairIndex.get(key) ?? 0
    pairIndex.set(key, slot + 1)
    edgeSlot.set(edge.id, slot)
    nodeSlots.set(edge.fromId, Math.max(nodeSlots.get(edge.fromId) ?? 1, slot + 1))
    nodeSlots.set(edge.toId, Math.max(nodeSlots.get(edge.toId) ?? 1, slot + 1))
  }
  return { nodeSlots, edgeSlot }
})

const flowNodes = computed<Node<RelationNodeData>[]>(() =>
  props.nodes.map((node) => ({
    id: node.id,
    type: 'relation',
    position: { x: node.x, y: node.y },
    data: {
      label: node.label,
      nodeType: node.nodeType,
      summary: node.summary,
      status: node.status,
      dimmed: props.focusNodeId !== '' && node.id !== props.focusNodeId,
      parallelSlots: parallel.value.nodeSlots.get(node.id) ?? 1,
    },
    draggable: true,
  })),
)

const flowEdges = computed<Edge[]>(() =>
  props.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromId,
    target: edge.toId,
    // 平行边各占一个手柄槽位（src-0 / tgt-0 为中心默认槽）
    sourceHandle: `src-${parallel.value.edgeSlot.get(edge.id) ?? 0}`,
    targetHandle: `tgt-${parallel.value.edgeSlot.get(edge.id) ?? 0}`,
    type: 'default',
    label: edge.label,
    markerEnd: MarkerType.ArrowClosed,
    style: {
      strokeWidth: 2,
      stroke: edge.id === props.selectedEdgeId ? '#2563eb' : '#94a3b8',
      opacity: edge.dimmed ? 0.2 : 1,
    },
    labelStyle: { fill: '#475569', fontSize: '11px' },
    labelBgStyle: { fill: '#ffffff' },
  })),
)

const { onNodeDragStop, onNodeClick, onEdgeClick, onPaneClick } = useVueFlow()

onNodeDragStop(({ nodes }) => {
  for (const node of nodes) {
    emit('dragStop', node.id, { x: node.position.x, y: node.position.y })
  }
})

onNodeClick(({ node }) => {
  emit('nodeClick', node.id)
})

onEdgeClick(({ edge }) => {
  emit('edgeClick', edge.id)
})

onPaneClick(() => {
  emit('paneClick')
})

function typeColor(nodeType: string): string {
  return TYPE_COLORS[nodeType] ?? TYPE_COLORS.ghost!
}

function typeLabel(nodeType: string): string {
  return TYPE_LABELS[nodeType] ?? nodeType
}

/** 手柄纵向位置：单槽居中（默认），多槽均匀分布在 1/(n+1) … n/(n+1) 高度处 */
function handleTop(slot: number, total: number): Record<string, string> {
  if (total <= 1) {
    return {}
  }
  return { top: `${((slot + 1) / (total + 1)) * 100}%` }
}
</script>

<template>
  <div class="relative h-full w-full">
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :nodes-draggable="true"
      :nodes-connectable="false"
      :elements-selectable="true"
      fit-view-on-init
      class="h-full w-full"
    >
      <template #node-relation="nodeProps">
        <div
          :class="[
            'relative min-w-[150px] max-w-[210px] rounded-xl border-2 bg-white px-3 py-2 shadow-md transition-opacity',
            nodeProps.data.dimmed ? 'opacity-30' : 'opacity-100',
          ]"
          :style="{
            borderColor: typeColor(nodeProps.data.nodeType),
            borderStyle: nodeProps.data.status === 'resolved' ? 'solid' : 'dashed',
          }"
        >
          <Handle
            v-for="slotIndex in nodeProps.data.parallelSlots"
            :key="`tgt-${slotIndex}`"
            type="target"
            :id="`tgt-${slotIndex - 1}`"
            :position="Position.Left"
            :style="{ background: typeColor(nodeProps.data.nodeType), ...handleTop(slotIndex - 1, nodeProps.data.parallelSlots) }"
          />
          <div class="mb-0.5 flex items-center gap-1.5">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :style="{ background: typeColor(nodeProps.data.nodeType) }"
            />
            <span class="truncate text-sm font-semibold text-gray-800">{{ nodeProps.data.label }}</span>
          </div>
          <p class="text-[10px] leading-tight text-gray-400">{{ typeLabel(nodeProps.data.nodeType) }}</p>
          <p v-if="nodeProps.data.summary" class="mt-0.5 line-clamp-2 text-xs leading-snug text-gray-500">
            {{ nodeProps.data.summary }}
          </p>
          <Handle
            v-for="slotIndex in nodeProps.data.parallelSlots"
            :key="`src-${slotIndex}`"
            type="source"
            :id="`src-${slotIndex - 1}`"
            :position="Position.Right"
            :style="{ background: typeColor(nodeProps.data.nodeType), ...handleTop(slotIndex - 1, nodeProps.data.parallelSlots) }"
          />
        </div>
      </template>
    </VueFlow>
  </div>
</template>
