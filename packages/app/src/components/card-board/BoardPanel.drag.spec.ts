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
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

import BoardPanel from './BoardPanel.vue'
import type { DragAnimationClock } from './drag-slot-animation'

type TestCard = { id: string }

function mountBoard(options: { canDropCard?: (id: string, columnKey: string) => boolean; animationClock?: DragAnimationClock } = {}) {
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
      ...(options.animationClock ? { animationClock: options.animationClock } : {}),
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
      configurable: true,
      value: () => ({ ...rect, bottom: rect.top + rect.height, left: 0, right: 256, width: 256, x: 0, y: rect.top, toJSON: () => ({}) }),
    })
    Object.defineProperty(card.element, 'offsetHeight', { value: 80 })
  })
}

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '', setDragImage: vi.fn() })

async function startDrag(wrapper: VueWrapper) {
  await wrapper.find('[data-card-id="drag"]').trigger('dragstart', { dataTransfer: dataTransfer() })
}

async function dragOverDoneColumn(wrapper: VueWrapper, clientY: number) {
  await wrapper.findAll('section')[1]!.trigger('dragover', { clientY, dataTransfer: dataTransfer() })
}

function fakeAnimationClock(): DragAnimationClock & { advance: (ms: number) => Promise<void> } {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: DragAnimationClock = {
    now: () => now,
    setTimer: (callback, delay) => {
      const key = ++id
      timers.set(key, { at: now + delay, callback })
      return key as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      timers.delete(timer as unknown as number)
    },
  }
  return {
    ...clock,
    advance: async (ms) => {
      const end = now + ms
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [key, timer] = next
        timers.delete(key)
        now = timer.at
        timer.callback()
        await Promise.resolve()
      }
      now = end
      await nextTick()
    },
  }
}

describe('BoardPanel 拖拽落点（中心线 + 占位卡）', () => {
  it('拖影在源卡片透明化与塌陷之前锁定，快照稍后清理', async () => {
    vi.useFakeTimers()
    const wrapper = mountBoard()
    stubCardGeometry(wrapper)
    const source = wrapper.find('[data-card-id="drag"]')
    Object.defineProperty(source.element, 'offsetHeight', { value: 80 })
    Object.defineProperty(source.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, left: 0, width: 200, height: 80 }),
    })
    const transfer = dataTransfer()

    await source.trigger('dragstart', { dataTransfer: transfer, clientX: 40, clientY: 20 })

    expect(transfer.setDragImage).toHaveBeenCalledOnce()
    const [image, offsetX, offsetY] = transfer.setDragImage.mock.calls[0]!
    expect((image as HTMLElement).classList.contains('opacity-0')).toBe(false)
    expect((image as HTMLElement).style.opacity).toBe('1')
    expect(offsetX).toBe(40)
    expect(offsetY).toBe(20)
    expect(source.element.parentElement!.getAttribute('style')).toContain('height: 88px')
    await vi.runAllTimersAsync()
    expect(source.classes()).toContain('opacity-0')
    expect(source.element.parentElement!.getAttribute('style')).toContain('height: 0px')
    expect((image as HTMLElement).isConnected).toBe(false)
    vi.useRealTimers()
  })

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

  it('换落点：旧占位独立收缩，新占位从 0 展开而不是直接终态', async () => {
    const clock = fakeAnimationClock()
    const wrapper = mountBoard({ animationClock: clock })
    stubCardGeometry(wrapper)
    await startDrag(wrapper)
    await dragOverDoneColumn(wrapper, 100)
    await clock.advance(90)
    const first = wrapper.find('[data-testid="board-drop-placeholder"]')
    const firstSlot = first.element.parentElement as HTMLElement
    const firstKey = firstSlot.getAttribute('data-drop-placeholder-key')
    const midHeight = parseFloat(firstSlot.style.height)
    expect(midHeight).toBeGreaterThan(0)
    expect(midHeight).toBeLessThan(80)
    expect(parseFloat((first.element as HTMLElement).style.opacity)).toBe(0)
    await clock.advance(110)
    await nextTick()
    expect(firstSlot.getAttribute('style')).toContain('height: 80px')
    await clock.advance(60)
    expect(parseFloat((first.element as HTMLElement).style.opacity)).toBeGreaterThan(0)
    expect(parseFloat((first.element as HTMLElement).style.opacity)).toBeLessThan(1)
    await clock.advance(80)
    expect((first.element as HTMLElement).style.opacity).toBe('1')
    await nextTick()
    await dragOverDoneColumn(wrapper, 10)
    const slots = wrapper.findAll('[data-drop-placeholder-key]')
    expect(slots).toHaveLength(2)
    const nextSlot = slots.find((slot) => slot.attributes('data-drop-placeholder-key') !== firstKey)!
    expect(nextSlot.attributes('style')).toContain('height: 0px')
    await clock.advance(90)
    await nextTick()
    const nextMidHeight = parseFloat((nextSlot.element as HTMLElement).style.height)
    const previousMidHeight = parseFloat((wrapper.find(`[data-drop-placeholder-key="${firstKey}"]`).element as HTMLElement).style.height)
    expect(nextMidHeight).toBeGreaterThan(0)
    expect(nextMidHeight).toBeLessThan(80)
    expect(previousMidHeight).toBeGreaterThan(0)
    expect(previousMidHeight).toBeLessThan(80)
    await clock.advance(110)
    await nextTick()
    expect(nextSlot.attributes('style')).toContain('height: 80px')
    expect(wrapper.findAll('[data-drop-placeholder-key]')).toHaveLength(1)
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
