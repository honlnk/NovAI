// @vitest-environment happy-dom
/**
 * 计划详情面板的领域接线基线（六个模块布局统一计划 阶段 0）：
 * 计划是「卡片骨架 + 单正文 Markdown/textarea」的装配，本文件证明领域事件
 * （标题/正文/状态/模式）确实从领域组件接到骨架再上抛。骨架删除后（阶段 3）
 * 同样断言改为对统一详情布局的适配层执行。
 *
 * 运行方式：pnpm --filter @novai/app exec vitest run src/components/plan
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import PlanDetailPanel from './PlanDetailPanel.vue'

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(PlanDetailPanel, {
    props: {
      activeCard: {
        id: 'p1',
        title: '埋线：主角身世',
        status: 'inbox',
        body: '正文内容',
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
      ...overrides,
    },
  })
}

describe('计划详情：领域字段与骨架接线', () => {
  it('头部标题输入发出 updateDraftTitle；正文草稿优先于磁盘正文展示', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="plan-detail-title"]').setValue('新计划名')
    expect(wrapper.emitted('updateDraftTitle')).toEqual([['新计划名']])

    const preview = wrapper.find('[data-testid="plan-detail-preview"]')
    expect(preview.text()).toContain('正文内容')
    await wrapper.setProps({ draftBody: '草稿正文' })
    expect(wrapper.find('[data-testid="plan-detail-preview"]').text()).toContain('草稿正文')
  })

  it('预览双击进入编辑；编辑态正文输入发出 updateDraft', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-testid="plan-detail-preview"]').trigger('dblclick')
    expect(wrapper.emitted('setDetailMode')).toEqual([['edit']])

    await wrapper.setProps({ detailMode: 'edit' })
    await wrapper.find('[data-testid="plan-detail-body"]').setValue('改后的正文')
    expect(wrapper.emitted('updateDraft')).toEqual([['改后的正文']])
  })

  it('守护冻结（frozen 透传）：双击不进编辑，textarea 只读', async () => {
    const wrapper = mountPanel({ guard: { kind: 'renamed', toPath: 'plans/moved.md' } })
    await wrapper.find('[data-testid="plan-detail-preview"]').trigger('dblclick')
    expect(wrapper.emitted('setDetailMode')).toBeUndefined()

    await wrapper.setProps({ detailMode: 'edit' })
    expect(wrapper.find('[data-testid="plan-detail-body"]').attributes('readonly')).toBeDefined()
  })

  it('状态按钮点击发出 updateDraftStatus（状态 key 上抛）', async () => {
    const wrapper = mountPanel()
    const button = wrapper.findAll('button').find((b) => b.text() === '进行中')
    expect(button).toBeDefined()
    await button!.trigger('click')
    expect(wrapper.emitted('updateDraftStatus')).toEqual([['in-progress']])
  })

  it('保存阶段与冲突事件透传骨架（failed 重试 / 紧凑条展开）', async () => {
    const wrapper = mountPanel({ savePhase: 'failed' })
    await wrapper.find('[data-testid="plan-detail-retry"]').trigger('click')
    expect(wrapper.emitted('retrySave')).toHaveLength(1)

    await wrapper.setProps({ conflict: { probing: false, missing: false, expanded: false } })
    await wrapper.find('[data-testid="plan-detail-conflict-compare"]').trigger('click')
    expect(wrapper.emitted('expandConflict')).toHaveLength(1)
  })

  it('冲突展开后守护横幅与处理出口仍在（消息区常驻），常规工具与主内容被替代', () => {
    const wrapper = mountPanel({
      conflict: { probing: false, missing: false, expanded: true },
      conflictFields: [
        { key: 'body', label: '正文', kind: 'long', mine: '我的修改', disk: 'AI 的修改' },
      ],
      guard: { kind: 'deleted', trashPath: '.trash/plans/p1.md' },
    })
    // 守护横幅与其两个出口不随冲突展开消失（修复批：消息区常驻）
    expect(wrapper.text()).toContain('已被删除')
    expect(wrapper.find('[data-testid="card-guard-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="card-guard-discard"]').exists()).toBe(true)
    // 冲突比较同屏在场（说明与比较区可达）
    expect(wrapper.find('[data-testid="detail-conflict-resolution"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('这张卡片有两个版本')
    // 常规工具区与主内容被冲突比较替代
    expect(wrapper.find('[data-testid="plan-detail-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="card-status-tools"]').exists()).toBe(false)
  })

  it('受控副本状态透传：守护恢复与冲突副本共用 conflictCopyBusy/Error', async () => {
    const wrapper = mountPanel({
      conflict: { probing: false, missing: false, expanded: true },
      conflictFields: [
        { key: 'body', label: '正文', kind: 'long', mine: '我的修改', disk: 'AI 的修改' },
      ],
      conflictCopyBusy: true,
      conflictCopyError: '新建失败：目录写入被拒绝',
    })
    // 冲突副本：busy 禁用提交文案、错误行可见
    await wrapper.findAll('button').find((b) => b.text() === '将我的内容另存为新卡片')!.trigger('click')
    expect(wrapper.find('[data-testid="detail-conflict-copy-error"]').text()).toBe('新建失败：目录写入被拒绝')
    const submit = wrapper.findAll('button').find((b) => b.text().includes('保存中…'))!
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)

    // 守护恢复（非展开态横幅）：同源 busy/error 透传到恢复表单
    const guarded = mountPanel({ guard: { kind: 'deleted' }, conflictCopyBusy: true, conflictCopyError: '新建失败' })
    await guarded.find('[data-testid="card-guard-restore"]').trigger('click')
    const restoreSubmit = guarded.find('[data-testid="card-guard-copy-submit"]')
    expect((restoreSubmit.element as HTMLButtonElement).disabled).toBe(true)
    expect(guarded.find('[data-testid="card-guard-copy-error"]').text()).toBe('新建失败')
  })
})
