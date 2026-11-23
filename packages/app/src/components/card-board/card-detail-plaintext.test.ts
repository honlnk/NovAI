// @vitest-environment happy-dom
/**
 * 卡片详情正文纯文本预览回归（2026-11-23 真机缺陷修复）：
 * 节奏意图/计划正文/伏笔双正文是 textarea 自由文本而非 markdown 源，预览原用
 * MarkdownRenderer 渲染——CommonMark 把段落内单换行折叠成空格（真机「111 挤一行」），
 * 且行首 #/列表标记/引号弯化都是意外变形。修复后统一 whitespace-pre-wrap 纯文本，
 * 与 txt 文件预览同语义。聊天气泡与 md 文件预览的 markdown 渲染不受本修复影响。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ForeshadowingDetailPanel from '../foreshadowing/ForeshadowingDetailPanel.vue'
import PlanDetailPanel from '../plan/PlanDetailPanel.vue'
import RhythmDetailPanel from '../rhythm/RhythmDetailPanel.vue'

const MULTILINE = '111\n1\n1\n1'

function expectPlaintextBody(wrapper: ReturnType<typeof mount>, text: string) {
  // 预览正文不再走 markdown 渲染
  expect(wrapper.find('.markdown-body').exists()).toBe(false)
  // 插值保留原始换行符（白空格折叠交给 whitespace-pre-wrap 呈现）
  const matched = wrapper
    .findAll('.whitespace-pre-wrap')
    .filter((node) => node.element.textContent === text)
  expect(matched.length).toBeGreaterThan(0)
}

describe('卡片详情正文纯文本预览', () => {
  it('节奏意图：多行自由文本换行保留，不再走 markdown 渲染', async () => {
    const wrapper = mount(RhythmDetailPanel, {
      props: {
        activeCard: {
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
          actualConflict: 5,
          actualMood: null,
          actualHook: null,
          actualPayoff: null,
          deviationFlag: false,
          judgmentSource: 'auto',
          thresholdPending: false,
          authorDeviationNote: null,
          lastJudgmentThreshold: null,
          summary: '',
          sourcePath: 'rhythm/r1.md',
          plannedCharacters: [],
          plannedNote: '',
          actualNote: '',
          deviationNote: '',
          intentBody: MULTILINE,
          linkBody: `衔接：${MULTILINE}`,
          authorNoteBody: `备注：${MULTILINE}`,
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
        detailMode: 'preview',
        savePhase: 'clean',
        conflict: null,
        conflictFields: [],
        guard: null,
        conflictCopyBusy: false,
        conflictCopyError: '',
        actionError: '',
      },
    })
    expectPlaintextBody(wrapper, MULTILINE)

    // 上下文衔接/作者备注默认折叠在「更多正文」里，展开后同口径断言（合并配套修复）
    await wrapper.find('[data-testid="rhythm-detail-more-toggle"]').trigger('click')
    expectPlaintextBody(wrapper, `衔接：${MULTILINE}`)
    expectPlaintextBody(wrapper, `备注：${MULTILINE}`)
    wrapper.unmount()
  })

  it('计划正文：多行自由文本换行保留，不再走 markdown 渲染', () => {
    const wrapper = mount(PlanDetailPanel, {
      props: {
        activeCard: {
          id: 'p1',
          title: '埋线：主角身世',
          status: 'inbox',
          body: MULTILINE,
          updatedAt: '2026-11-20T10:00:00Z',
          sourcePath: 'plans/p1.md',
        },
        draftBody: null,
        draftTitle: null,
        draftStatus: null,
        detailMode: 'preview',
        savePhase: 'clean',
        conflict: null,
        conflictFields: [],
        guard: null,
        conflictCopyBusy: false,
        conflictCopyError: '',
        actionError: '',
      },
    })
    expectPlaintextBody(wrapper, MULTILINE)
    wrapper.unmount()
  })

  it('伏笔读者视角与作者真相：多行自由文本换行保留，不再走 markdown 渲染', () => {
    const wrapper = mount(ForeshadowingDetailPanel, {
      props: {
        activeCard: {
          id: 'f1',
          name: '阁楼里的钢琴声',
          status: 'planted',
          order: 0,
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-20T10:00:00Z',
          plantedAt: '第一卷/第003章',
          payoffWindow: ['第一卷/第010章', '第一卷/第020章'],
          isRedHerring: false,
          payoffStart: null,
          payoffEnd: null,
          relatedChapters: ['第一卷/第005章'],
          summary: '',
          sourcePath: 'foreshadowings/f1.md',
          relatedCharacters: [],
          relatedEntities: [],
          resolvedAt: null,
          abandonedReason: null,
          readerBody: MULTILINE,
          authorTruth: `真相：${MULTILINE}`,
          contentHash: 'h1',
        },
        draftName: null,
        draftReaderView: null,
        draftAuthorTruth: null,
        draftStatus: null,
        draftPlantedAt: null,
        draftPayoffStart: null,
        draftPayoffEnd: null,
        draftRelatedCharactersText: null,
        draftRelatedEntitiesText: null,
        draftRelatedChapters: null,
        draftIsRedHerring: null,
        draftResolvedAt: null,
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
        windowMismatch: false,
        windowMismatchViews: null,
        canAdoptWindow: false,
        reasonRevision: null,
        canConfirmReasonRevision: false,
        isConfirmingReasonRevision: false,
        detailMode: 'preview',
        savePhase: 'clean',
        conflict: null,
        conflictFields: [],
        guard: null,
        conflictCopyBusy: false,
        conflictCopyError: '',
        abandonIntent: null,
        canConfirmAbandon: true,
        isConfirmingAbandon: false,
        actionError: '',
      },
    })
    expectPlaintextBody(wrapper, MULTILINE)
    expectPlaintextBody(wrapper, `真相：${MULTILINE}`)
    wrapper.unmount()
  })
})
