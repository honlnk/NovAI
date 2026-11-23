// @vitest-environment happy-dom
/**
 * 伏笔详情面板的领域接线基线（六个模块布局统一计划 阶段 0）：
 * 伏笔领域专有行为——六状态按钮（已放弃拦截进原因操作态）、操作态两种进入
 * 路径都默认聚焦原因输入、读者视角/作者真相双正文输入、取消/确认事件。
 * 这些行为在阶段 3 迁移到统一布局后必须原样保留。
 *
 * 运行方式：pnpm --filter @novai/app exec vitest run src/components/foreshadowing
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import ForeshadowingDetailPanel from './ForeshadowingDetailPanel.vue'
import type { ForeshadowingCardView } from '@novai/core/services/types'

function activeCard(overrides: Partial<ForeshadowingCardView> = {}): ForeshadowingCardView {
  return {
    id: 'f1',
    name: '阁楼里的钢琴声',
    status: 'planted',
    order: 0,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    plantedAt: '第一卷/第003章',
    payoffStart: null,
    payoffEnd: null,
    payoffWindow: ['第一卷/第010章', '第一卷/第020章'] as [string, string],
    isRedHerring: false,
    relatedChapters: ['第一卷/第005章'],
    summary: '',
    sourcePath: 'foreshadowings/f1.md',
    relatedCharacters: ['林远'],
    relatedEntities: [],
    resolvedAt: null,
    abandonedReason: null,
    readerBody: '读者看到的线索',
    authorTruth: '作者知道的真相',
    contentHash: 'h1',
    ...overrides,
  }
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  const wrapper = mount(ForeshadowingDetailPanel, {
    // attachTo：原因输入默认聚焦断言依赖 document.activeElement，脱离文档的
    // 元素 focus() 不会成为 activeElement
    attachTo: document.body,
    props: {
      activeCard: activeCard(),
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
      windowMismatch: false,
      windowMismatchViews: null,
      canAdoptWindow: true,
      reasonRevision: null,
      canConfirmReasonRevision: true,
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
      ...overrides,
    },
  })
  return wrapper
}

/** 卸载并清空挂载容器，避免 activeElement 污染后续用例 */
function unmount(wrapper: ReturnType<typeof mountPanel>) {
  wrapper.unmount()
  document.body.innerHTML = ''
}

describe('伏笔详情：标题与双正文接线', () => {
  it('标题/读者视角/作者真相输入分别发出对应草稿事件；草稿优先展示', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="foreshadowing-detail-title"]').setValue('新伏笔名')
    expect(wrapper.emitted('updateDraftName')).toEqual([['新伏笔名']])

    expect(wrapper.find('[data-testid="foreshadowing-detail-reader"]').text()).toContain('读者看到的线索')
    expect(wrapper.find('[data-testid="foreshadowing-detail-truth"]').text()).toContain('作者知道的真相')
    await wrapper.setProps({ draftReaderView: '读者草稿', draftAuthorTruth: '真相草稿' })
    expect(wrapper.find('[data-testid="foreshadowing-detail-reader"]').text()).toContain('读者草稿')
    expect(wrapper.find('[data-testid="foreshadowing-detail-truth"]').text()).toContain('真相草稿')

    await wrapper.setProps({ detailMode: 'edit' })
    await wrapper.find('[data-testid="foreshadowing-detail-reader-input"]').setValue('读者输入')
    expect(wrapper.emitted('updateDraftReaderView')).toEqual([['读者输入']])
    await wrapper.find('[data-testid="foreshadowing-detail-truth-input"]').setValue('真相输入')
    expect(wrapper.emitted('updateDraftAuthorTruth')).toEqual([['真相输入']])
  })

  it('双正文预览双击进入编辑（一个区域双击即可）', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="foreshadowing-detail-reader"]').trigger('dblclick')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])
  })
})

describe('伏笔详情：状态与放弃操作态', () => {
  it('普通状态按钮发出 updateDraftStatus；「放弃」拦截进 startAbandon', async () => {
    const wrapper = mountPanel()
    try {
      const statusButton = wrapper.findAll('button').find((b) => b.text() === '解决')
      expect(statusButton).toBeDefined()
      await statusButton!.trigger('click')
      expect(wrapper.emitted('updateDraftStatus')).toEqual([['resolved']])

      const abandonButton = wrapper.findAll('button').find((b) => b.text() === '放弃')
      expect(abandonButton).toBeDefined()
      await abandonButton!.trigger('click')
      expect(wrapper.emitted('updateDraftStatus')).toEqual([['resolved']])
      expect(wrapper.emitted('startAbandon')).toHaveLength(1)
    } finally {
      unmount(wrapper)
    }
  })

  it('挂载即存在操作态：原因输入默认聚焦（拖入已放弃列路径）', async () => {
    const wrapper = mountPanel({ abandonIntent: { reason: '' } })
    try {
      await nextTick()
      await nextTick()
      expect(wrapper.find('[data-testid="foreshadowing-detail-abandon-reason"]').element).toBe(document.activeElement)
    } finally {
      unmount(wrapper)
    }
  })

  it('后续进入操作态同样聚焦；原因输入发出 updateAbandonReason', async () => {
    const wrapper = mountPanel()
    try {
      expect(wrapper.find('[data-testid="foreshadowing-detail-abandon"]').exists()).toBe(false)

      await wrapper.setProps({ abandonIntent: { reason: '' } })
      await nextTick()
      await nextTick()
      const reason = wrapper.find('[data-testid="foreshadowing-detail-abandon-reason"]')
      expect(reason.element).toBe(document.activeElement)
      await reason.setValue('被第三章取代')
      expect(wrapper.emitted('updateAbandonReason')).toEqual([['被第三章取代']])
    } finally {
      unmount(wrapper)
    }
  })

  it('操作态收起双正文；取消与确认事件接线，确认按钮空原因禁用', async () => {
    const wrapper = mountPanel({ abandonIntent: { reason: '' } })
    try {
      expect(wrapper.find('[data-testid="foreshadowing-detail-reader"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="foreshadowing-detail-truth"]').exists()).toBe(false)

      const confirm = wrapper.find('[data-testid="foreshadowing-detail-abandon-confirm"]')
      expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
      // 受控输入：原因由父组件回写 props
      await wrapper.setProps({ abandonIntent: { reason: '节奏拖沓' } })
      expect((wrapper.find('[data-testid="foreshadowing-detail-abandon-confirm"]').element as HTMLButtonElement).disabled).toBe(false)

      await wrapper.find('[data-testid="foreshadowing-detail-abandon-cancel"]').trigger('click')
      expect(wrapper.emitted('cancelAbandon')).toHaveLength(1)
      await wrapper.find('[data-testid="foreshadowing-detail-abandon-confirm"]').trigger('click')
      expect(wrapper.emitted('confirmAbandon')).toHaveLength(1)
    } finally {
      unmount(wrapper)
    }
  })

  it('已放弃状态展示历史放弃原因（高级信息展开后只读展示）', async () => {
    const wrapper = mountPanel({
      activeCard: activeCard({ status: 'abandoned', abandonedReason: '线索已失效' }),
    })
    try {
      await wrapper.find('[data-testid="foreshadowing-detail-advanced-toggle"]').trigger('click')
      expect(wrapper.text()).toContain('放弃原因')
      expect(wrapper.text()).toContain('线索已失效')
    } finally {
      unmount(wrapper)
    }
  })
})

describe('伏笔详情：结构信息与骨架接线', () => {
  it('结构字段默认折叠、展开后只读展示（埋设章节/回收窗口/关联角色）', async () => {
    const wrapper = mountPanel()
    // 默认折叠：只显示辅助说明，不展示具体字段值
    expect(wrapper.find('[data-testid="foreshadowing-detail-advanced-toggle"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('第一卷/第003章')
    await wrapper.find('[data-testid="foreshadowing-detail-advanced-toggle"]').trigger('click')
    expect(wrapper.text()).toContain('埋设章节')
    expect(wrapper.text()).toContain('第一卷/第003章')
    expect(wrapper.text()).toContain('第一卷/第010章 ~ 第一卷/第020章')
    expect(wrapper.text()).toContain('林远')
    wrapper.unmount()
  })

  it('保存失败重试与冲突比较入口透传', async () => {
    const wrapper = mountPanel({ savePhase: 'failed' })
    await wrapper.find('[data-testid="foreshadowing-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retrySave')).toHaveLength(1)

    await wrapper.setProps({ conflict: { probing: false, missing: false, expanded: false } })
    await wrapper.find('[data-testid="foreshadowing-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expandConflict')).toHaveLength(1)
  })

  it('冲突展开后守护横幅与处理出口仍在（消息区常驻），常规工具与主内容被替代', () => {
    const wrapper = mountPanel({
      conflict: { probing: false, missing: false, expanded: true },
      conflictFields: [
        { key: 'readerBody', label: '读者视角', kind: 'long', mine: '我的修改', disk: 'AI 的修改' },
      ],
      guard: { kind: 'deleted', trashPath: '.trash/foreshadowings/f1.md' },
    })
    expect(wrapper.text()).toContain('已被删除')
    expect(wrapper.find('[data-testid="card-guard-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="card-guard-discard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-conflict-resolution"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('这张卡片有两个版本')
    expect(wrapper.find('[data-testid="foreshadowing-detail-reader"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="card-status-tools"]').exists()).toBe(false)
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})

describe('伏笔详情：高级信息编辑与明确操作（阶段 2）', () => {
  async function mountEdit(overrides: Record<string, unknown> = {}) {
    const wrapper = mountPanel({ detailMode: 'edit', ...overrides })
    await wrapper.find('[data-testid="foreshadowing-detail-advanced-toggle"]').trigger('click')
    return wrapper
  }

  it('编辑模式展示控件：红鲱鱼/关联角色输入发出草稿事件；实际回收不一致就地说明', async () => {
    const wrapper = await mountEdit({
      activeCard: activeCard({ status: 'planted', resolvedAt: '第一卷/第009章' }),
    })
    try {
      await wrapper.get('[data-testid="foreshadowing-detail-red-herring"]').setValue(true)
      expect(wrapper.emitted('updateDraftIsRedHerring')).toEqual([[true]])

      await wrapper.get('[data-testid="foreshadowing-detail-related-characters"]').setValue('林远、阿四')
      expect(wrapper.emitted('updateDraftRelatedCharactersText')).toEqual([['林远、阿四']])

      // 普通未收状态登记了实际回收章节：就地说明，不阻止保存
      expect(wrapper.text()).toContain('当前状态不是已揭晓或已解决')
    } finally {
      unmount(wrapper)
    }
  })

  it('窗口不一致三出口：并列展示两套数据，按钮发出明确操作，返回收起横幅', async () => {
    const wrapper = await mountEdit({
      windowMismatch: true,
      windowMismatchViews: { structured: '第15章 ~ 开放终点', legacy: '第020章 ~ 开放终点' },
    })
    try {
      const banner = wrapper.get('[data-testid="foreshadowing-detail-window-mismatch"]')
      expect(banner.text()).toContain('第15章')
      expect(banner.text()).toContain('第020章')
      expect(banner.text()).toContain('相对位置记录不保留')

      await wrapper.get('[data-testid="foreshadowing-detail-mismatch-structured"]').trigger('click')
      expect(wrapper.emitted('adoptStructuredWindow')).toHaveLength(1)
      await wrapper.get('[data-testid="foreshadowing-detail-mismatch-legacy"]').trigger('click')
      expect(wrapper.emitted('adoptLegacyWindow')).toHaveLength(1)

      // 返回：收起横幅（两套数据与当前输入保留）
      await wrapper.get('[data-testid="foreshadowing-detail-mismatch-back"]').trigger('click')
      expect(wrapper.find('[data-testid="foreshadowing-detail-window-mismatch"]').exists()).toBe(false)
    } finally {
      unmount(wrapper)
    }
  })

  it('未收口时窗口出口禁用（等 clean）', async () => {
    const wrapper = await mountEdit({
      windowMismatch: true,
      windowMismatchViews: { structured: '第15章 ~ 开放终点', legacy: '第020章 ~ 开放终点' },
      canAdoptWindow: false,
    })
    try {
      expect((wrapper.get('[data-testid="foreshadowing-detail-mismatch-structured"]').element as HTMLButtonElement).disabled).toBe(true)
    } finally {
      unmount(wrapper)
    }
  })

  it('已放弃卡的历史原因修订：入口→原位输入→空值禁用应用→应用/取消事件', async () => {
    const wrapper = await mountEdit({
      activeCard: activeCard({ status: 'abandoned', abandonedReason: '旧原因' }),
    })
    try {
      // 未进操作态：只读展示 + 入口
      expect(wrapper.text()).toContain('旧原因')
      await wrapper.get('[data-testid="foreshadowing-detail-revision-start"]').trigger('click')
      expect(wrapper.emitted('startReasonRevision')).toHaveLength(1)
    } finally {
      unmount(wrapper)
    }

    // 操作态激活会自动展开高级信息（不再手动点开，避免把展开态切回折叠）
    const revising = mountPanel({
      detailMode: 'edit',
      activeCard: activeCard({ status: 'abandoned', abandonedReason: '旧原因' }),
      reasonRevision: { reason: '' },
    })
    try {
      // 操作态由 reasonRevision 驱动（面板只渲染）
      const confirm = revising.get('[data-testid="foreshadowing-detail-revision-confirm"]')
      expect((confirm.element as HTMLButtonElement).disabled).toBe(true)

      await revising.get('[data-testid="foreshadowing-detail-revision-reason"]').setValue('修订后的原因')
      expect(revising.emitted('updateReasonRevision')).toEqual([['修订后的原因']])
      // 挂载测试没有 v-model 回灌：手动回传父层会同步的状态
      await revising.setProps({ reasonRevision: { reason: '修订后的原因' } })
      expect((confirm.element as HTMLButtonElement).disabled).toBe(false)

      await revising.get('[data-testid="foreshadowing-detail-revision-cancel"]').trigger('click')
      expect(revising.emitted('cancelReasonRevision')).toHaveLength(1)
      await confirm.trigger('click')
      expect(revising.emitted('confirmReasonRevision')).toHaveLength(1)
    } finally {
      unmount(revising)
    }
  })

  it('章节已创建提示按 prop 展示', async () => {
    const wrapper = await mountEdit({ chapterCreateNotice: '章节已创建（第021章），卡片引用尚未保存。' })
    try {
      expect(wrapper.get('[data-testid="foreshadowing-detail-chapter-created-notice"]').text())
        .toContain('卡片引用尚未保存')
    } finally {
      unmount(wrapper)
    }
  })
})
