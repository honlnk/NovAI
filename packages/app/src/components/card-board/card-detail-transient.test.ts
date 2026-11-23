// @vitest-environment happy-dom
/**
 * 节奏详情临时编辑集成（2026-11-23 交互增补）：预览态双击正文进入临时编辑，
 * savePhase 相位转变 pending/saving → clean 时面板自动发出回预览事件；
 * 静置无改动亮「等待保存」并同窗静置到期直接回预览（不触发保存）；
 * 点「编辑」按钮进入的常规编辑不自动回预览。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import RhythmDetailPanel from '../rhythm/RhythmDetailPanel.vue'

type SavePhase = 'clean' | 'pending' | 'saving' | 'failed' | 'conflict'

function mountPanel(props: {
  detailMode: 'preview' | 'edit'
  savePhase: SavePhase
}) {
  return mount(RhythmDetailPanel, {
    props: {
      activeCard: {
        id: 'r1',
        name: '测试节奏卡',
        status: 'planned',
        order: 0,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-20T10:00:00Z',
        chapterRef: '第五章',
        plannedConflict: 8,
        plannedMood: '紧张',
        plannedHook: '情感爆发',
        plannedPayoff: '揭秘',
        actualConflict: null,
        actualMood: null,
        actualHook: null,
        actualPayoff: null,
        deviationFlag: false,
        judgmentSource: 'auto',
        thresholdPending: false,
        authorDeviationNote: null,
        lastJudgmentThreshold: null,
        summary: '',
        sourcePath: 'rhythm/R-006-测试节奏卡.md',
        plannedCharacters: ['鸿影'],
        plannedNote: '',
        actualNote: '',
        deviationNote: '',
        intentBody: '111\n1\n1',
        linkBody: '',
        authorNoteBody: '',
        contentHash: 'h1',
      },
      draftName: null,
      draftPlannedConflict: null,
      draftPlannedMood: null,
      draftPlannedHook: null,
      draftPlannedPayoff: null,
      draftPlannedCharacters: null,
      draftPlannedNote: null,
      draftIntentBody: null,
      judgmentSource: 'auto',
      thresholdPending: false,
      historicalAuthorNote: null,
      comparisonEditWarning: false,
      restoreAutoPreview: null,
      authorCorrection: null,
      correctionPlacement: null,
      restoreAutoPending: false,
      canConfirmAuthorCorrection: false,
      canConfirmRestoreAuto: false,
      isConfirmingJudgment: false,
      draftChapterRef: null,
      draftActualConflict: null,
      draftActualMood: null,
      draftActualHook: null,
      draftActualPayoff: null,
      draftActualNote: null,
      draftLinkBody: null,
      draftAuthorNoteBody: null,
      picker: {
        catalog: { entries: [], duplicateNumbers: new Set<number>(), maxNumber: null },
        catalogReady: false,
        loading: false,
        loadError: null,
        suggestedNumber: null,
        createHandler: null,
        sessionKey: 'spec',
        latestChapterNumber: null,
      },
      chapterCreateNotice: null,
      conflict: null,
      conflictFields: [],
      guard: null,
      conflictCopyBusy: false,
      conflictCopyError: '',
      actionError: '',
      ...props,
    },
  })
}

async function setPhase(wrapper: ReturnType<typeof mountPanel>, phase: SavePhase) {
  await wrapper.setProps({ savePhase: phase })
}

describe('节奏详情临时编辑', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('预览态双击正文 → 临时标记 + 发出进入编辑；保存完成相位转变 → 自动发出回预览', async () => {
    const wrapper = mountPanel({ detailMode: 'preview', savePhase: 'clean' })
    await wrapper.find('[data-testid="rhythm-detail-intent"]').trigger('dblclick')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])

    // 进入编辑态，走一轮保存相位
    await wrapper.setProps({ detailMode: 'edit' })
    await setPhase(wrapper, 'pending')
    await setPhase(wrapper, 'saving')
    await setPhase(wrapper, 'clean')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit'], ['preview']])
    wrapper.unmount()
  })

  it('点「编辑」按钮进入的常规编辑：保存完成不自动回预览', async () => {
    const wrapper = mountPanel({ detailMode: 'preview', savePhase: 'clean' })
    // 顶部编辑按钮（非双击）——走 detail-mode-edit
    await wrapper.find('[data-testid="detail-mode-edit"]').trigger('click')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])
    await wrapper.setProps({ detailMode: 'edit' })
    await setPhase(wrapper, 'pending')
    await setPhase(wrapper, 'clean')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])
    wrapper.unmount()
  })

  it('双击后不输入：状态灯显示「等待保存」，静置到期直接发出回预览', async () => {
    const wrapper = mountPanel({ detailMode: 'preview', savePhase: 'clean' })
    await wrapper.find('[data-testid="rhythm-detail-intent"]').trigger('dblclick')
    await wrapper.setProps({ detailMode: 'edit' })

    // 相位仍 clean（无改动）：展示层覆写为「等待保存」
    expect(wrapper.text()).toContain('等待保存')
    expect(wrapper.find('[data-testid="rhythm-detail-intent-input"]').exists()).toBe(true)

    // 静置 2 秒无操作：直接发出回预览，未经过任何保存相位
    await vi.advanceTimersByTimeAsync(2000 + 20)
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit'], ['preview']])
    wrapper.unmount()
  })

  it('临时编辑中遇冲突：升级常规，冲突解除（clean）不弹回', async () => {
    const wrapper = mountPanel({ detailMode: 'preview', savePhase: 'clean' })
    await wrapper.find('[data-testid="rhythm-detail-intent"]').trigger('dblclick')
    await wrapper.setProps({ detailMode: 'edit' })
    await setPhase(wrapper, 'pending')
    await setPhase(wrapper, 'conflict')
    await setPhase(wrapper, 'clean')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])
    wrapper.unmount()
  })
})
