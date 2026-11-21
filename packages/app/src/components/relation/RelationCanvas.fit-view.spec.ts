// @vitest-environment happy-dom
/**
 * 关系画布首载 fitView（关系图谱施工计划 §八 验收项 8 修复）：
 * fit-view-on-init 在图谱数据加载完成前就跑，空画布上算出的视口不随节点更新；
 * 弹窗重开时节点在挂载前就绪，init 也不再触发——窄屏（375px）下节点被裁出画布。
 * 画布组件需在「挂载即有节点」与「挂载后异步到达」两种场景各补一次 fitView，
 * 且只补一次（后续重载保持用户视口，不重置）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { RelationCanvasEdge, RelationCanvasNode } from '../../stores/relation'

const fitView = vi.hoisted(() => vi.fn())

vi.mock('@vue-flow/core', () => ({
  VueFlow: { name: 'VueFlow', props: ['nodes', 'edges', 'nodesDraggable', 'nodesConnectable', 'elementsSelectable', 'fitViewOnInit'], template: '<div class="vue-flow-mock" />' },
  useVueFlow: () => ({
    onNodeDragStop: vi.fn(),
    onNodeClick: vi.fn(),
    onEdgeClick: vi.fn(),
    onPaneClick: vi.fn(),
    fitView,
  }),
  Handle: { name: 'Handle', template: '<div />' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}))

const RelationCanvas = (await import('./RelationCanvas.vue')).default

function node(id: string, x = 100, y = 100): RelationCanvasNode {
  return { id, elementId: id, label: id, nodeType: 'character', summary: '', status: 'resolved', x, y }
}

const edge: RelationCanvasEdge = { id: 'REL-1111111111', fromId: 'a', toId: 'b', label: '盟友', description: '', dimmed: false }

function mountCanvas(nodes: RelationCanvasNode[]) {
  return mount(RelationCanvas, {
    props: { nodes, edges: nodes.length > 1 ? [edge] : [], selectedEdgeId: '', focusNodeId: '' },
  })
}

describe('RelationCanvas 首载 fitView', () => {
  beforeEach(() => {
    fitView.mockClear()
  })

  it('挂载即有节点（弹窗重开场景）：立即补一次 fitView', async () => {
    mountCanvas([node('a'), node('b')])
    await Promise.resolve()
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.15 }))
  })

  it('挂载后节点异步到达（首次打开场景）：0→N 跳变时补一次 fitView', async () => {
    const wrapper = mountCanvas([])
    await Promise.resolve()
    expect(fitView).not.toHaveBeenCalled()
    await wrapper.setProps({ nodes: [node('a'), node('b')], edges: [edge] })
    // watch 回调里还挂了一层 nextTick，多排一层微任务再断言
    await Promise.resolve()
    await Promise.resolve()
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('后续节点更新不重复 fitView（保持用户视口）', async () => {
    const wrapper = mountCanvas([node('a')])
    await wrapper.setProps({ nodes: [node('a'), node('b')], edges: [edge] })
    await wrapper.setProps({ nodes: [node('a'), node('b'), node('c')], edges: [edge] })
    expect(fitView).toHaveBeenCalledTimes(1)
  })
})
