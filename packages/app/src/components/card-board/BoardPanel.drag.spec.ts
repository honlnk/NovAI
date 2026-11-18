// @vitest-environment happy-dom
/**
 * 看板拖拽落点重设计的组件面（原位塌陷 + 中心线落点 + 占位卡）：
 * 根 vitest 配置无 Vue SFC 插件（共享配置不动），本文件用 .spec.ts 避开根
 * include（*.test.ts），由 packages/app 目录（vite.config.js 含 @vitejs/plugin-vue）
 * 单独运行：pnpm --filter @novai/app exec vitest run src/components/card-board
 *
 * 覆盖：中心线上/下方分别落到锚点后/前、列首 beforeId 上抛、无效落点不显示
 * 占位也不上抛、取消拖拽清理占位。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

import BoardPanel from './BoardPanel.vue'

type TestCard = { id: string }

function mountBoard(options: { canDropCard?: (id: string, columnKey: string) => boolean } = {}) {
  const cards: Record<string, TestCard[]> = {
    todo: [{ id: 'drag' }],
    done: [{ id: 'a' }, { id: 'b' }],
  }
  return mount(BoardPanel, {
    props: {
      title: '测试看板',
      totalCards: 3,
      columns: [
        { key: 'todo', label: '待办', cards: cards.todo! },
        { key: 'done', label: '完成', cards: cards.done! },
      ],
      skeletonColumnCount: 2,
      hasBoardData: true,
      isLoading: false,
      errorMessage: '',
      selectedCardId: null,
      isSidebarOpen: true,
      isContentPanelOpen: false,
      emptyText: '还没有卡片',
      emptyCreateLabel: '新建卡片',
      testidPrefix: 'board',
      ...(options.canDropCard ? { canDropCard: options.canDropCard } : {}),
    },
    slots: {
      'card-content': '<p>卡片内容</p>',
    },
  })
}

/** 覆盖 happy-dom 的零几何：目标列两张卡各 80 高、间距 8（中心线 40 / 128） */
function stubCardGeometry(wrapper: VueWrapper) {
  const rects = [
    { top: 0, height: 80 },
    { top: 88, height: 80 },
  ]
  wrapper.findAll('[data-card-id]').forEach((card) => {
    const rect = rects[card.attributes('data-card-id') === 'b' ? 1 : 0]!
    Object.defineProperty(card.element, 'getBoundingClientRect', {
      value: () => ({ ...rect, bottom: rect.top + rect.height, left: 0, right: 256, width: 256, x: 0, y: rect.top, toJSON: () => ({}) }),
    })
    Object.defineProperty(card.element, 'offsetHeight', { value: 80 })
  })
}

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '' })

async function startDrag(wrapper: VueWrapper) {
  await wrapper.find('[data-card-id="drag"]').trigger('dragstart', { dataTransfer: dataTransfer() })
}

async function dragOverDoneColumn(wrapper: VueWrapper, clientY: number) {
  await wrapper.findAll('section')[1]!.trigger('dragover', { clientY, dataTransfer: dataTransfer() })
}

describe('BoardPanel 拖拽落点（中心线 + 占位卡）', () => {
  it('中心线下方插锚点之后：显示占位卡，松手上抛 afterId', async () => {
    const wrapper = mountBoard()
    stubCardGeometry(wrapper)
    await startDrag(wrapper)
    await dragOverDoneColumn(wrapper, 100)

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="board-drop-placeholder"]').exists()).toBe(true)
    })

    await wrapper.findAll('section')[1]!.trigger('drop', { dataTransfer: dataTransfer() })
    const events = wrapper.emitted('moveCard')
    expect(events).toHaveLength(1)
    expect(events![0]).toEqual(['drag', 'done', 'a'])
  })

  it('中心线上方插锚点之前：列首落点上抛 beforeId', async () => {
    const wrapper = mountBoard()
    stubCardGeometry(wrapper)
    await startDrag(wrapper)
    await dragOverDoneColumn(wrapper, 10)

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="board-drop-placeholder"]').exists()).toBe(true)
    })
    // 占位卡在 a 之前：DOM 序列 占位 a b（被拖卡仍在原列，塌陷为 0 高）
    const order = wrapper.findAll('[data-board-cards]')[1]!
      .findAll('[data-testid="board-drop-placeholder"], [data-card-id]')
      .map((item) => item.attributes('data-card-id') ?? 'placeholder')
    expect(order).toEqual(['placeholder', 'a', 'b'])

    await wrapper.findAll('section')[1]!.trigger('drop', { dataTransfer: dataTransfer() })
    expect(wrapper.emitted('moveCard')).toEqual([['drag', 'done', null, 'a']])
  })

  it('无效落点（canDropCard 拒绝）：不显示占位，松手不上抛', async () => {
    const wrapper = mountBoard({ canDropCard: (id, columnKey) => id === 'drag' && columnKey === 'todo' })
    stubCardGeometry(wrapper)
    await startDrag(wrapper)
    await dragOverDoneColumn(wrapper, 100)
    await Promise.resolve()

    expect(wrapper.find('[data-testid="board-drop-placeholder"]').exists()).toBe(false)

    await wrapper.findAll('section')[1]!.trigger('drop', { dataTransfer: dataTransfer() })
    expect(wrapper.emitted('moveCard')).toBeUndefined()
  })

  it('取消拖拽：原位塌陷后随 dragend 恢复，占位卡收尾移除', async () => {
    const wrapper = mountBoard()
    stubCardGeometry(wrapper)
    await startDrag(wrapper)

    const sourceSlot = wrapper.find('[data-card-id="drag"]').element.parentElement!
    await vi.waitFor(() => {
      expect(sourceSlot.getAttribute('style')).toContain('height: 0px')
    })

    await dragOverDoneColumn(wrapper, 100)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="board-drop-placeholder"]').exists()).toBe(true)
    })

    await wrapper.find('[data-card-id="drag"]').trigger('dragend')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="board-drop-placeholder"]').exists()).toBe(false)
    })
    expect(wrapper.emitted('moveCard')).toBeUndefined()
  })
})
