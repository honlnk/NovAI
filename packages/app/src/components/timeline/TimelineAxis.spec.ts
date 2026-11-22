// @vitest-environment happy-dom
/**
 * 时间轴甘特视图组件（时间轴甘特图改造计划 §七 12–13）：
 * 点击菱形 / 横条 / 标题均选中事件；不再有拖拽移动事件；选中态与筛选淡出；空账本无 SVG 与残留线。
 *
 * 需 Vue 插件，用 app 的 vite 配置运行：
 *   node ../../node_modules/vitest/vitest.mjs run --config vite.config.js --dir src src/components/timeline/TimelineAxis.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import TimelineAxis from './TimelineAxis.vue'
import type { TimelineAxisNode } from '../../stores/timeline'
import type { GanttEntry } from '../../stores/timeline-gantt'
import type { TimelineEvent, TimelineMarker } from '@novai/core/types/timeline'

function event(title: string): TimelineEvent {
  return {
    title,
    summary: '',
    storyTime: null,
    relativeTime: null,
    participants: [],
    plotIds: [],
    chapters: [],
    causedBy: [],
    createdAt: '',
    updatedAt: '',
  }
}

/** A（点）→ B 开始 → C（点，B 内）→ B 结束 */
const markers: TimelineMarker[] = [
  { id: 'TM-a', kind: 'point', eventId: 'EVT-a', event: event('北境之战') },
  { id: 'TM-b1', kind: 'start', eventId: 'EVT-b', event: event('铁剑门兴起') },
  { id: 'TM-c', kind: 'point', eventId: 'EVT-c', event: event('战前三日') },
  { id: 'TM-b2', kind: 'end', eventId: 'EVT-b', startId: 'TM-b1' },
]

function nodes(): TimelineAxisNode[] {
  return markers.map((marker, index) => ({
    marker,
    ordinal: index + 1,
    eventId: marker.eventId,
    title: marker.kind === 'end' ? null : marker.event.title,
    dateLabel: '',
    spanEndIndex: marker.kind === 'start' ? 3 : null,
    matched: true,
  }))
}

function entries(overrides: Partial<Record<string, Partial<GanttEntry>>> = {}): GanttEntry[] {
  const base: GanttEntry[] = [
    { eventId: 'EVT-a', kind: 'point', title: '北境之战', dateLabel: '苍穹历·320年', startIndex: 0, endIndex: 0, matched: true },
    { eventId: 'EVT-b', kind: 'span', title: '铁剑门兴起', dateLabel: '', startIndex: 1, endIndex: 3, matched: true },
    { eventId: 'EVT-c', kind: 'point', title: '战前三日', dateLabel: '', startIndex: 2, endIndex: 2, matched: true },
  ]
  return base.map((entry) => ({ ...entry, ...overrides[entry.eventId] }))
}

function mountAxis(props: Partial<{ nodes: TimelineAxisNode[]; entries: GanttEntry[]; selectedEventId: string }> = {}) {
  return mount(TimelineAxis, {
    props: {
      nodes: props.nodes ?? nodes(),
      entries: props.entries ?? entries(),
      stepPx: 96,
      selectedEventId: props.selectedEventId ?? '',
    },
  })
}

describe('TimelineAxis 甘特视图', () => {
  it('表头每个标记一列；点事件与区间各画一个条目，日期灰字跟在标题后', () => {
    const wrapper = mountAxis()
    const svg = wrapper.get('[data-testid="timeline-axis-svg"]')
    expect(svg.findAll('text').filter((text) => /^[1-4]$/.test(text.text()))).toHaveLength(4)
    expect(wrapper.findAll('[data-testid^="timeline-item-"]')).toHaveLength(3)
    expect(wrapper.get('[data-testid="timeline-item-EVT-a"] tspan').text()).toBe('苍穹历·320年')
    expect(wrapper.get('[data-testid="timeline-item-EVT-b"]').find('rect').exists()).toBe(true)
    expect(wrapper.get('[data-testid="timeline-item-EVT-a"]').find('polygon').exists()).toBe(true)
    // 区间内的点事件与区间不同行
    const rowOf = (id: string) => wrapper.get(`[data-testid="timeline-item-${id}"]`).attributes('data-row')
    expect(rowOf('EVT-c')).not.toBe(rowOf('EVT-b'))
  })

  it('点击菱形、横条、标题文字（透明命中区）均触发 select-event；不再有 move-marker', async () => {
    const wrapper = mountAxis()
    await wrapper.get('[data-testid="timeline-item-EVT-a"] polygon').trigger('click')
    await wrapper.get('[data-testid="timeline-item-EVT-b"] rect').trigger('click')
    await wrapper.get('[data-testid="timeline-item-EVT-c"] text').trigger('click')
    await wrapper.get('[data-testid="timeline-item-EVT-c"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select-event')).toEqual([['EVT-a'], ['EVT-b'], ['EVT-c'], ['EVT-c']])

    await wrapper.get('[data-testid="timeline-item-EVT-a"]').trigger('pointerdown', { button: 0, clientX: 10 })
    await wrapper.get('[data-testid="timeline-axis-svg"]').trigger('pointerup', { clientX: 400 })
    expect(wrapper.emitted('move-marker')).toBeUndefined()
  })

  it('选中态：区间加深描边、点事件加外圈；筛选不命中的条目降透明度', () => {
    const wrapper = mountAxis({ selectedEventId: 'EVT-b', entries: entries({ 'EVT-a': { matched: false } }) })
    const span = wrapper.get('[data-testid="timeline-item-EVT-b"]')
    expect(span.attributes('aria-pressed')).toBe('true')
    expect(span.find('rect').attributes('stroke')).toBe('#4f46e5')
    expect(wrapper.get('[data-testid="timeline-item-EVT-a"]').attributes('opacity')).toBe('0.25')
    expect(wrapper.get('[data-testid="timeline-item-EVT-c"]').attributes('opacity')).toBe('1')

    const pointSelected = mountAxis({ selectedEventId: 'EVT-c' })
    expect(pointSelected.get('[data-testid="timeline-item-EVT-c"]').find('circle').exists()).toBe(true)
  })

  it('空账本：不渲染 SVG（无网格、无残留横线），显示空态文案', () => {
    const wrapper = mountAxis({ nodes: [], entries: [] })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('line').exists()).toBe(false)
    expect(wrapper.text()).toContain('时间轴为空')
  })
})
