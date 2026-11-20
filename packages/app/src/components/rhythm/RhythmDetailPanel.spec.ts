// @vitest-environment happy-dom
/**
 * 节奏详情面板的领域接线基线（六个模块布局统一计划 阶段 0）：
 * 节奏领域专有约束——不提供普通状态按钮（状态由回写偏差自动判定）、计划值
 * 控件只在编辑态可用、实际值只读对比、节奏意图双态正文。迁移统一布局后保留。
 *
 * 运行方式：pnpm --filter @novai/app exec vitest run src/components/rhythm
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import RhythmDetailPanel from './RhythmDetailPanel.vue'
import type { RhythmCardView } from '@novai/core/services/types'

function activeCard(overrides: Partial<RhythmCardView> = {}): RhythmCardView {
  return {
    id: 'r1',
    name: '第083章 节奏卡',
    status: 'written',
    order: 0,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    chapterRef: '第083章',
    plannedConflict: 5,
    plannedMood: '紧张',
    plannedHook: '悬念',
    plannedPayoff: '揭秘',
    actualConflict: 7,
    actualMood: '悲壮',
    actualHook: '悬念',
    actualPayoff: '揭秘',
    deviationFlag: true,
    summary: '',
    sourcePath: 'rhythm/r1.md',
    plannedCharacters: ['林远', '苏晚'],
    plannedNote: '铺垫要短',
    actualNote: '写长了',
    deviationNote: '冲突强度偏高',
    intentBody: '本章要绷紧。',
    linkBody: '',
    authorNoteBody: '',
    contentHash: 'h1',
    ...overrides,
  }
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(RhythmDetailPanel, {
    props: {
      activeCard: activeCard(),
      draftName: null,
      draftPlannedConflict: null,
      draftPlannedMood: null,
      draftPlannedHook: null,
      draftPlannedPayoff: null,
      draftPlannedCharacters: null,
      draftPlannedNote: null,
      draftIntentBody: null,
      detailMode: 'preview',
      savePhase: 'clean',
      conflict: null,
      conflictFields: [],
      guard: null,
      actionError: '',
      ...overrides,
    },
  })
}

/** 头部与正文区的全部按钮文字（预览/编辑切换、关闭等骨架控件除外） */
function statusButtonsAbsent(wrapper: ReturnType<typeof mountPanel>) {
  // 节奏三列标签不该以状态按钮形态出现（状态徽标是只读 span，不是按钮）
  const buttonTexts = wrapper.findAll('button').map((b) => b.text())
  return !buttonTexts.includes('规划中') && !buttonTexts.includes('已写') && !buttonTexts.includes('偏差')
}

describe('节奏详情：只读状态与计划值控件', () => {
  it('无普通状态按钮；状态徽标只读展示当前状态与关联章节', () => {
    const wrapper = mountPanel()
    expect(statusButtonsAbsent(wrapper)).toBe(true)
    expect(wrapper.find('[data-testid="rhythm-detail-status"]').text()).toBe('已写')
    expect(wrapper.text()).toContain('第083章')
  })

  it('预览态计划值控件全部禁用；编辑态可用并发出 updateDraft', async () => {
    const wrapper = mountPanel()
    expect((wrapper.find('[data-testid="rhythm-detail-conflict-slider"]').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="rhythm-detail-mood"]').element as HTMLSelectElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="rhythm-detail-characters"]').element as HTMLInputElement).disabled).toBe(true)

    await wrapper.setProps({ detailMode: 'edit' })
    const slider = wrapper.find('[data-testid="rhythm-detail-conflict-slider"]')
    expect((slider.element as HTMLInputElement).disabled).toBe(false)
    await slider.setValue('8')
    expect(wrapper.emitted('updateDraft')).toEqual([[{ plannedConflict: 8 }]])

    await wrapper.find('[data-testid="rhythm-detail-characters"]').setValue('林远、老周')
    const events = wrapper.emitted('updateDraft')!
    expect(events[events.length - 1]).toEqual([{ plannedCharacters: '林远、老周' }])
  })

  it('守护冻结时编辑态控件也禁用', async () => {
    const wrapper = mountPanel({ detailMode: 'edit', guard: { kind: 'deleted' } })
    expect((wrapper.find('[data-testid="rhythm-detail-conflict-slider"]').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="rhythm-detail-mood"]').element as HTMLSelectElement).disabled).toBe(true)
  })

  it('实际值只读对比与偏差说明展示（计划 vs 实际）', () => {
    const wrapper = mountPanel()
    const actual = wrapper.find('[data-testid="rhythm-detail-actual"]')
    expect(actual.text()).toContain('实际值（写后回写，只读）')
    expect(actual.text()).toContain('冲突强度')
    expect(actual.text()).toContain('计划 5')
    expect(actual.text()).toContain('实际 7')
    expect(actual.text()).toContain('冲突强度偏高')
    // 无实际值（规划中）不渲染实际值区
    const planned = mountPanel({ activeCard: activeCard({ status: 'planned', actualConflict: null }) })
    expect(planned.find('[data-testid="rhythm-detail-actual"]').exists()).toBe(false)
  })

  it('节奏意图预览双击进编辑；编辑态输入发出 updateDraft', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="rhythm-detail-intent"]').trigger('dblclick')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])

    await wrapper.setProps({ detailMode: 'edit' })
    await wrapper.find('[data-testid="rhythm-detail-intent-input"]').setValue('要绷得更紧')
    expect(wrapper.emitted('updateDraft')![0]).toEqual([{ intentBody: '要绷得更紧' }])
  })

  it('保存失败重试与冲突比较入口透传骨架', async () => {
    const wrapper = mountPanel({ savePhase: 'failed' })
    await wrapper.find('[data-testid="rhythm-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retrySave')).toHaveLength(1)

    await wrapper.setProps({ conflict: { probing: false, missing: false, expanded: false } })
    await wrapper.find('[data-testid="rhythm-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expandConflict')).toHaveLength(1)
  })
})
