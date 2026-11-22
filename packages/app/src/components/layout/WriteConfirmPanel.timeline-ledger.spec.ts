// @vitest-environment happy-dom
/**
 * AI 写入确认面板 × 时间线账本追加确认（时间线JSON化改造计划 §十二 阶段4）：
 * TimelineCreatePoint/Span 的 create 候选指向 elements/timeline.json（时间线账本）。
 * 账本是读改写的追加式 JSON，目标文件存在是常态而非「新建被占用」——与关系账本
 * 同一先例（WriteConfirmPanel.relation-ledger.spec.ts），面板不得按通用文件的
 * 「新建不覆盖」规则死锁同意按钮；复检放行交给工具自身的版本校验链。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { FileChangeConfirmationView, FileContentView } from '@novai/core/services/types'

import WriteConfirmPanel from './WriteConfirmPanel.vue'

const storeState = vi.hoisted(() => ({
  currentProject: null as { id: string; name: string; files: never[] } | null,
}))
const probeFile = vi.hoisted(() => vi.fn())

vi.mock('../../stores/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/project')>()
  return {
    ...actual,
    useProjectStore: () => ({
      get currentProject() {
        return storeState.currentProject
      },
      probeFile,
    }),
  }
})

const LEDGER_PATH = 'elements/timeline.json'
const DISK_LEDGER = JSON.stringify(
  { version: 1, markers: [{ id: 'TM-a', kind: 'point', eventId: 'EVT-1', event: { title: '北境之战' } }] },
  null,
  2,
)

function fileView(path: string, content: string): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt: 'v1' }
}

function mountLedgerCreate() {
  return mount(WriteConfirmPanel, {
    props: {
      confirmation: {
        id: 'cf-tl',
        toolName: 'TimelineCreatePoint',
        title: '登记时间线事件',
        summary: '新增一个点事件',
        confirmation: {
          kind: 'create',
          path: LEDGER_PATH,
          content: '新增事件「王都来使」（点事件）\n位置：末尾',
        },
      } as unknown as FileChangeConfirmationView,
      totalCount: 1,
    },
  })
}

describe('WriteConfirmPanel 时间线账本追加确认', () => {
  beforeEach(() => {
    storeState.currentProject = { id: 'p1', name: '甲项目', files: [] }
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView('elements/timeline.json', DISK_LEDGER) })
  })

  it('账本已存在不算「新建被占用」：不进失配态、同意按钮可点', async () => {
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增一个点事件'))

    expect(wrapper.text()).not.toContain('目标文件已存在')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree).toBeDefined()
    expect(agree.attributes('disabled')).toBeUndefined()
  })

  it('点击同意写入：复检放行 emit 一次 confirm（磁盘版本校验由工具链负责）', async () => {
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增一个点事件'))
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    await agree.trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('目标文件已存在')
  })

  it('账本尚不存在（首个事件落账）：探测 missing 也不进失配态，同意放行', async () => {
    probeFile.mockReset().mockResolvedValue({ kind: 'missing' })
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增一个点事件'))

    expect(wrapper.text()).not.toContain('目标文件已存在')
    expect(wrapper.text()).not.toContain('目标文件在磁盘上已不存在')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree.attributes('disabled')).toBeUndefined()
    await agree.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  // 删除确认不走本面板：rename/delete 由输入区接管（WriteActionTakeover）渲染，
  // 见 WriteActionTakeover.spec.ts 的账本条目删除文案用例。

  it('更新确认（edit 候选 + 占位符原文）：不被磁盘包含性检查误判失配，同意放行', async () => {
    const wrapper = mount(WriteConfirmPanel, {
      props: {
        confirmation: {
          id: 'cf-tl-edit',
          toolName: 'TimelineUpdate',
          title: '更新时间线事件',
          summary: '修改一个事件的字段',
          confirmation: {
            kind: 'edit',
            path: LEDGER_PATH,
            // 时间线工具的候选原文是展示用占位符，磁盘内容里必然找不到
            oldText: '（事件字段更新，差异以执行结果为准）',
            newText: '标题 → 王都来使入城\n摘要 → 北境之战后王都遣使北上',
          },
        } as unknown as FileChangeConfirmationView,
        totalCount: 1,
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('修改一个事件的字段'))

    expect(wrapper.text()).not.toContain('候选原文在当前文件中已找不到')
    expect(wrapper.text()).toContain('标题 → 王都来使入城')
    expect(wrapper.text()).not.toContain('目标文件当前不可读')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree).toBeDefined()
    expect(agree.attributes('disabled')).toBeUndefined()
    await agree.trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

})
