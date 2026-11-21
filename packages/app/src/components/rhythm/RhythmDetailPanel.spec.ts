// @vitest-environment happy-dom
/**
 * 节奏详情面板的领域接线（作者字段控制权计划 阶段 3 全面升级）：
 * 只读状态徽标（状态由回写偏差自动判定，作者校正入口属阶段 4）、
 * 关联章节走选择器（编辑态）与统一位置描述（预览态）、写后实际值
 * 常驻可补填（清除哨兵 0/''）、更多正文折叠区、判定与说明区。
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
    judgmentSource: 'auto',
    thresholdPending: false,
    summary: '',
    sourcePath: 'rhythm/r1.md',
    plannedCharacters: ['林远', '苏晚'],
    plannedNote: '铺垫要短',
    actualNote: '写长了',
    deviationNote: '冲突强度偏高',
    authorDeviationNote: null,
    lastJudgmentThreshold: 3,
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
      draftChapterRef: null,
      draftPlannedConflict: null,
      draftPlannedMood: null,
      draftPlannedHook: null,
      draftPlannedPayoff: null,
      draftPlannedCharacters: null,
      draftPlannedNote: null,
      draftIntentBody: null,
      draftActualConflict: null,
      draftActualMood: null,
      draftActualHook: null,
      draftActualPayoff: null,
      draftActualNote: null,
      draftLinkBody: null,
      draftAuthorNoteBody: null,
      picker: {
        catalog: { entries: [], duplicateNumbers: new Set<number>(), maxNumber: 0 },
        catalogReady: false,
        loading: false,
        loadError: null,
        suggestedNumber: null,
        createHandler: null,
        sessionKey: 'spec',
        latestChapterNumber: null,
      },
      chapterCreateNotice: null,
      detailMode: 'preview',
      savePhase: 'clean',
      conflict: null,
      conflictFields: [],
      guard: null,
      conflictCopyBusy: false,
      conflictCopyError: '',
      actionError: '',
      judgmentSource: 'auto',
      thresholdPending: false,
      historicalAuthorNote: null,
      comparisonEditWarning: false,
      restoreAutoPreview: null,
      authorCorrection: null,
      restoreAutoPending: false,
      canConfirmAuthorCorrection: true,
      canConfirmRestoreAuto: true,
      isConfirmingJudgment: false,
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

/** 最近一次 updateDraft 事件的负载（spec tsconfig lib 早于 es2022，不用 Array.at） */
function lastUpdateDraft(wrapper: ReturnType<typeof mountPanel>) {
  const events = wrapper.emitted('updateDraft')!
  return events[events.length - 1]
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

  it('冲突展开后守护横幅与处理出口仍在（消息区常驻），主内容被替代', () => {
    const wrapper = mountPanel({
      conflict: { probing: false, missing: false, expanded: true },
      conflictFields: [
        { key: 'intentBody', label: '节奏意图', kind: 'long', mine: '我的修改', disk: 'AI 的修改' },
      ],
      guard: { kind: 'deleted', trashPath: '.trash/rhythm/r1.md' },
    })
    expect(wrapper.text()).toContain('已被删除')
    expect(wrapper.find('[data-testid="card-guard-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="card-guard-discard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-conflict-resolution"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('这张卡片有两个版本')
    expect(wrapper.find('[data-testid="rhythm-detail-intent"]').exists()).toBe(false)
  })

  it('短高度纵向滚动责任：领域内容整列滚动承载全部控件与节奏意图，底部固定不参与滚动', () => {
    const preview = mountPanel()
    const scroll = preview.find('[data-testid="rhythm-detail-scroll"]')
    expect(scroll.classes()).toContain('overflow-y-auto')
    expect(scroll.classes()).toContain('flex-1')
    // 全部计划值控件与节奏意图都在滚动列内（短高度下滚动可达）
    expect(scroll.find('[data-testid="rhythm-detail-conflict-slider"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="rhythm-detail-mood"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="rhythm-detail-characters"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="rhythm-detail-planned-note"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="rhythm-detail-actual"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="rhythm-detail-intent"]').exists()).toBe(true)
    // DetailLayout 固定底部仍在滚动列外（路径与时间不随内容滚动）
    expect(preview.find('[data-testid="detail-footer-path"]').exists()).toBe(true)
    expect(scroll.find('[data-testid="detail-footer-path"]').exists()).toBe(false)

    // 编辑态同样整列滚动，意图输入在列内
    const edit = mountPanel({ detailMode: 'edit' })
    const editScroll = edit.find('[data-testid="rhythm-detail-scroll"]')
    expect(editScroll.classes()).toContain('overflow-y-auto')
    expect(editScroll.find('[data-testid="rhythm-detail-intent-input"]').exists()).toBe(true)
    expect(edit.find('[data-testid="detail-footer-path"]').exists()).toBe(true)
  })
})

describe('节奏详情：关联章节（阶段 3 选择器接线）', () => {
  it('预览态显示原文描述与判定提示；「章节已创建」提示透传', () => {
    const wrapper = mountPanel({ chapterCreateNotice: '章节已创建（第084章-新章），卡片引用尚未保存。' })
    const section = wrapper.find('[data-testid="rhythm-detail-chapter"]')
    expect(section.text()).toContain('第083章')
    expect(section.find('[data-testid="rhythm-detail-chapter-created-notice"]').text()).toContain('卡片引用尚未保存')
  })

  it('目录就绪且引用无法归类时给出兼容原文提示（琥珀条，编辑态）', () => {
    const wrapper = mountPanel({
      activeCard: activeCard({ chapterRef: '序章' }),
      detailMode: 'edit',
      picker: {
        catalog: { entries: [], duplicateNumbers: new Set<number>(), maxNumber: 0 },
        catalogReady: true,
        loading: false,
        loadError: null,
        suggestedNumber: null,
        createHandler: null,
        sessionKey: 'spec',
        latestChapterNumber: null,
      },
    })
    expect(wrapper.find('[data-testid="rhythm-detail-chapter"]').text()).toContain('兼容原文')
    expect(wrapper.find('[data-testid="rhythm-detail-chapter"]').text()).toContain('序章')
  })
})

describe('节奏详情：写后实际值（常驻区，阶段 3 可编辑）', () => {
  it('预览态展示计划↔实际对照与自评；规划中卡也常驻展示并提示可补填', () => {
    const wrapper = mountPanel()
    const actual = wrapper.find('[data-testid="rhythm-detail-actual"]')
    expect(actual.text()).toContain('写后实际值')
    expect(actual.text()).toContain('冲突强度')
    expect(actual.text()).toContain('计划 5')
    expect(actual.text()).toContain('实际 7')
    expect(actual.text()).toContain('本章自评：写长了')

    const planned = mountPanel({ activeCard: activeCard({ status: 'planned', actualConflict: null, actualMood: null, actualHook: null, actualPayoff: null, actualNote: null, deviationFlag: false }) })
    const plannedActual = planned.find('[data-testid="rhythm-detail-actual"]')
    expect(plannedActual.exists()).toBe(true)
    expect(plannedActual.text()).toContain('尚未回写实际值')
    expect(plannedActual.text()).toContain('实际 —')
  })

  it('编辑态实际冲突滑块发出数值；「未填写」按钮发出清除哨兵 0；未填时「按计划值填写」从计划值起步', async () => {
    const wrapper = mountPanel({ detailMode: 'edit' })
    await wrapper.find('[data-testid="rhythm-detail-actual-conflict-slider"]').setValue('9')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualConflict: 9 }])
    await wrapper.find('[data-testid="rhythm-detail-actual-conflict-clear"]').trigger('click')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualConflict: 0 }])

    const empty = mountPanel({
      detailMode: 'edit',
      activeCard: activeCard({ actualConflict: null, actualMood: null, actualHook: null, actualPayoff: null }),
    })
    await empty.find('[data-testid="rhythm-detail-actual-conflict-fill"]').trigger('click')
    expect(lastUpdateDraft(empty)).toEqual([{ actualConflict: 5 }])
  })

  it('实际枚举下拉含「未填写」清除选项（发出空串哨兵）；自评输入透传', async () => {
    const wrapper = mountPanel({ detailMode: 'edit' })
    await wrapper.find('[data-testid="rhythm-detail-actual-mood"]').setValue('轻松')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualMood: '轻松' }])
    await wrapper.find('[data-testid="rhythm-detail-actual-mood"]').setValue('')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualMood: '' }])
    await wrapper.find('[data-testid="rhythm-detail-actual-hook"]').setValue('')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualHook: '' }])
    await wrapper.find('[data-testid="rhythm-detail-actual-payoff"]').setValue('')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualPayoff: '' }])

    await wrapper.find('[data-testid="rhythm-detail-actual-note"]').setValue('按计划落地')
    expect(lastUpdateDraft(wrapper)).toEqual([{ actualNote: '按计划落地' }])
  })

  it('判定与说明区：偏差自动说明常驻；保存期间提示将按阈值重判', () => {
    const wrapper = mountPanel()
    const judgment = wrapper.find('[data-testid="rhythm-detail-judgment"]')
    expect(judgment.text()).toContain('偏差（自动判定）')
    expect(judgment.text()).toContain('冲突强度偏高')

    const pending = mountPanel({ savePhase: 'pending' })
    expect(pending.find('[data-testid="rhythm-detail-judgment"]').text()).toContain('保存后将按项目阈值重新判定')

    const consistent = mountPanel({ activeCard: activeCard({ deviationFlag: false }) })
    expect(consistent.find('[data-testid="rhythm-detail-judgment"]').text()).toContain('已写：与计划一致（自动判定）')
  })
})

describe('节奏详情：更多正文折叠区（上下文衔接 / 作者备注）', () => {
  it('默认折叠；展开后预览态显示正文、编辑态输入发出 updateDraft', async () => {
    const wrapper = mountPanel({ activeCard: activeCard({ linkBody: '上一章冷开场，本章升温。', authorNoteBody: '别再用倒叙。' }) })
    const more = wrapper.find('[data-testid="rhythm-detail-more"]')
    expect(more.find('[data-testid="rhythm-detail-link"]').exists()).toBe(false)
    expect(more.find('[data-testid="rhythm-detail-author-note"]').exists()).toBe(false)

    await wrapper.find('[data-testid="rhythm-detail-more-toggle"]').trigger('click')
    expect(more.find('[data-testid="rhythm-detail-link"]').text()).toContain('上一章冷开场')
    expect(more.find('[data-testid="rhythm-detail-author-note"]').text()).toContain('别再用倒叙')

    await wrapper.setProps({ detailMode: 'edit' })
    await wrapper.find('[data-testid="rhythm-detail-link-input"]').setValue('新的衔接说明')
    expect(lastUpdateDraft(wrapper)).toEqual([{ linkBody: '新的衔接说明' }])
    await wrapper.find('[data-testid="rhythm-detail-author-note-input"]').setValue('新的作者备注')
    expect(lastUpdateDraft(wrapper)).toEqual([{ authorNoteBody: '新的作者备注' }])
  })
})

describe('节奏详情：判定操作态（阶段 4 §五）', () => {
  it('自动卡：无作者徽标，提供「作者校正」入口、无「恢复自动判定」', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="rhythm-detail-judgment-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="rhythm-detail-correct-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rhythm-detail-restore-auto-button"]').exists()).toBe(false)
  })

  it('作者卡：状态旁显示作者校正徽标；判定区展示作者说明与恢复自动入口', async () => {
    const wrapper = mountPanel({
      activeCard: activeCard({ judgmentSource: 'author', authorDeviationNote: '刻意升温，别动' }),
      judgmentSource: 'author',
    })
    expect(wrapper.find('[data-testid="rhythm-detail-judgment-badge"]').text()).toBe('作者校正')
    expect(wrapper.find('[data-testid="rhythm-detail-judgment"]').text()).toContain('刻意升温，别动')
    expect(wrapper.find('[data-testid="rhythm-detail-restore-auto-button"]').exists()).toBe(true)

    await wrapper.find('[data-testid="rhythm-detail-correct-button"]').trigger('click')
    expect(wrapper.emitted('startAuthorCorrection')).toHaveLength(1)
    await wrapper.find('[data-testid="rhythm-detail-restore-auto-button"]').trigger('click')
    expect(wrapper.emitted('startRestoreAuto')).toHaveLength(1)
  })

  it('阈值待复核与比较值警告：轻量提示各自呈现（作者卡注明人工结论保留）', () => {
    const wrapper = mountPanel({ thresholdPending: true, comparisonEditWarning: true, judgmentSource: 'author' })
    const judgment = wrapper.find('[data-testid="rhythm-detail-judgment"]')
    expect(judgment.find('[data-testid="rhythm-detail-threshold-pending"]').text()).toContain('阈值已变化，可重新检查')
    expect(judgment.find('[data-testid="rhythm-detail-threshold-pending"]').text()).toContain('人工结论保留')
    expect(judgment.find('[data-testid="rhythm-detail-comparison-warning"]').text()).toContain('保存后将按新值重算并恢复自动判定')
  })

  it('校正表单：状态联动偏差结论（规划中锁无偏差/偏差锁有偏差），说明输入上抛', async () => {
    const wrapper = mountPanel({ authorCorrection: { status: 'written', deviationFlag: false, deviationNote: '' } })
    const form = wrapper.find('[data-testid="rhythm-detail-correction-form"]')
    expect(form.exists()).toBe(true)
    // 表单出现时入口按钮隐藏
    expect(wrapper.find('[data-testid="rhythm-detail-correct-button"]').exists()).toBe(false)

    await form.find('[data-testid="rhythm-detail-correction-status"]').setValue('planned')
    expect(wrapper.emitted('updateAuthorCorrection')![0]).toEqual([{ status: 'planned', deviationFlag: false }])
    await form.find('[data-testid="rhythm-detail-correction-status"]').setValue('deviated')
    expect(wrapper.emitted('updateAuthorCorrection')![1]).toEqual([{ status: 'deviated', deviationFlag: true }])

    await form.find('[data-testid="rhythm-detail-correction-note"]').setValue('走样说明')
    expect(wrapper.emitted('updateAuthorCorrection')![2]).toEqual([{ deviationNote: '走样说明' }])
  })

  it('校正表单门禁：有偏差缺说明禁用应用并就地说明；缺实际比较值提示先补', async () => {
    const missing = mountPanel({ authorCorrection: { status: 'deviated', deviationFlag: true, deviationNote: '   ' } })
    expect((missing.find('[data-testid="rhythm-detail-correction-apply"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(missing.find('[data-testid="rhythm-detail-correction-note-missing"]').text()).toContain('必须填写偏差说明')

    // 已写/偏差需要实际比较值（默认卡 actualConflict=7 满足）→ 无先补提示
    const ok = mountPanel({ authorCorrection: { status: 'written', deviationFlag: false, deviationNote: '' } })
    expect(ok.find('[data-testid="rhythm-detail-correction-needs-actual"]').exists()).toBe(false)

    const plannedNoActual = mountPanel({
      activeCard: activeCard({ status: 'planned', actualConflict: null, actualMood: null, actualHook: null, actualPayoff: null, deviationFlag: false }),
      authorCorrection: { status: 'written', deviationFlag: false, deviationNote: '' },
    })
    expect((plannedNoActual.find('[data-testid="rhythm-detail-correction-apply"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(plannedNoActual.find('[data-testid="rhythm-detail-correction-needs-actual"]').text()).toContain('本章自评不计入')

    await ok.find('[data-testid="rhythm-detail-correction-apply"]').trigger('click')
    expect(ok.emitted('confirmAuthorCorrection')).toHaveLength(1)
    await ok.find('[data-testid="rhythm-detail-correction-cancel"]').trigger('click')
    expect(ok.emitted('cancelAuthorCorrection')).toHaveLength(1)

    // 冲突/守护冻结确认（门禁 prop 透传）
    const frozen = mountPanel({ authorCorrection: { status: 'written', deviationFlag: false, deviationNote: '' }, canConfirmAuthorCorrection: false })
    expect((frozen.find('[data-testid="rhythm-detail-correction-apply"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('恢复自动两步确认：展示当前作者结论与预演对照；确认/取消上抛', async () => {
    const wrapper = mountPanel({
      activeCard: activeCard({ judgmentSource: 'author', deviationFlag: false, authorDeviationNote: '先压着' }),
      judgmentSource: 'author',
      restoreAutoPending: true,
      restoreAutoPreview: { status: 'deviated', deviationFlag: true, deviationNote: '情绪基调偏差：计划 紧张 实际 悲壮' },
    })
    const block = wrapper.find('[data-testid="rhythm-detail-restore-auto"]')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('当前作者结论：已写 · 无偏差')
    expect(block.find('[data-testid="rhythm-detail-restore-auto-preview"]').text()).toContain('恢复后自动结论：偏差 · 有偏差')
    expect(block.find('[data-testid="rhythm-detail-restore-auto-preview"]').text()).toContain('情绪基调偏差')

    await block.find('[data-testid="rhythm-detail-restore-auto-confirm"]').trigger('click')
    expect(wrapper.emitted('confirmRestoreAuto')).toHaveLength(1)
    await block.find('[data-testid="rhythm-detail-restore-auto-cancel"]').trigger('click')
    expect(wrapper.emitted('cancelRestoreAuto')).toHaveLength(1)
  })

  it('历史人工说明：恢复自动后默认折叠展示作者历史说明', () => {
    const wrapper = mountPanel({ historicalAuthorNote: '恢复自动前的作者说明' })
    const details = wrapper.find('[data-testid="rhythm-detail-historical-note"]')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('恢复自动前的作者说明')
    expect(details.find('summary').text()).toContain('历史人工说明')
  })
})
