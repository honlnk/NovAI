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

function activeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    name: '阁楼里的钢琴声',
    status: 'planted',
    order: 0,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    plantedAt: '第一卷/第003章',
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
      detailMode: 'preview',
      savePhase: 'clean',
      conflict: null,
      conflictFields: [],
      guard: null,
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

  it('已放弃状态展示历史放弃原因', () => {
    const wrapper = mountPanel({
      activeCard: activeCard({ status: 'abandoned', abandonedReason: '线索已失效' }),
    })
    try {
      expect(wrapper.text()).toContain('放弃原因')
      expect(wrapper.text()).toContain('线索已失效')
    } finally {
      unmount(wrapper)
    }
  })
})

describe('伏笔详情：结构信息与骨架接线', () => {
  it('结构字段只读展示（埋设章节/回收窗口/关联角色）', () => {
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('埋设章节')
    expect(wrapper.text()).toContain('第一卷/第003章')
    expect(wrapper.text()).toContain('第一卷/第010章 ~ 第一卷/第020章')
    expect(wrapper.text()).toContain('林远')
  })

  it('保存失败重试与冲突比较入口透传', async () => {
    const wrapper = mountPanel({ savePhase: 'failed' })
    await wrapper.find('[data-testid="foreshadowing-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retrySave')).toHaveLength(1)

    await wrapper.setProps({ conflict: { probing: false, missing: false, expanded: false } })
    await wrapper.find('[data-testid="foreshadowing-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expandConflict')).toHaveLength(1)
  })
})
