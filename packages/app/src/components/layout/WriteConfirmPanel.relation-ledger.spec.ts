// @vitest-environment happy-dom
/**
 * AI 写入确认面板 × 关系账本追加确认（关系图谱施工计划 §八 验收项 3 修复）：
 * RelationCreate 的 create 候选指向 relations.json（关系账本）。账本是读改写的
 * 追加式 JSON，目标文件存在是常态而非「新建被占用」——面板不得按通用文件的
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

const LEDGER_PATH = 'elements/relations.json（关系账本）'
const DISK_LEDGER = JSON.stringify({ version: 1, relations: [], layout: {} }, null, 2)

function fileView(path: string, content: string): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt: 'v1' }
}

function mountLedgerCreate() {
  return mount(WriteConfirmPanel, {
    props: {
      confirmation: {
        id: 'cf-rel',
        toolName: 'RelationCreate',
        title: '登记关系',
        summary: '新增一条关系',
        confirmation: {
          kind: 'create',
          path: LEDGER_PATH,
          content: '新增关系：魏征 → 李世民（君臣）',
        },
      } as unknown as FileChangeConfirmationView,
      totalCount: 1,
    },
  })
}

describe('WriteConfirmPanel 关系账本追加确认', () => {
  beforeEach(() => {
    storeState.currentProject = { id: 'p1', name: '甲项目', files: [] }
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView('elements/relations.json', DISK_LEDGER) })
  })

  it('账本已存在不算「新建被占用」：不进失配态、同意按钮可点', async () => {
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增关系'))

    expect(wrapper.text()).not.toContain('目标文件已存在')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree).toBeDefined()
    expect(agree.attributes('disabled')).toBeUndefined()
  })

  it('点击同意写入：复检放行 emit 一次 confirm（磁盘版本校验由工具链负责）', async () => {
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增关系'))
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    await agree.trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('目标文件已存在')
  })

  it('账本尚不存在（首条关系落账）：探测 missing 也不进失配态，同意放行', async () => {
    probeFile.mockReset().mockResolvedValue({ kind: 'missing' })
    const wrapper = mountLedgerCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新增关系'))

    expect(wrapper.text()).not.toContain('目标文件已存在')
    expect(wrapper.text()).not.toContain('目标文件在磁盘上已不存在')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree.attributes('disabled')).toBeUndefined()
    await agree.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('对照组：普通文件的 create 候选目标已存在仍被初次探测拦截', async () => {
    const wrapper = mount(WriteConfirmPanel, {
      props: {
        confirmation: {
          id: 'cf-file',
          toolName: 'create_file',
          title: '新建正文',
          summary: '创建一份正文',
          confirmation: { kind: 'create', path: 'chapters/new.txt', content: '新文件' },
        } as unknown as FileChangeConfirmationView,
        totalCount: 1,
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('新文件'))

    expect(wrapper.text()).toContain('目标文件已存在')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree.attributes('disabled')).toBeDefined()
  })

  it('更新/删除确认（edit 候选 + 占位符原文）：不被磁盘包含性检查误判失配，同意放行', async () => {
    const wrapper = mount(WriteConfirmPanel, {
      props: {
        confirmation: {
          id: 'cf-rel-edit',
          toolName: 'RelationUpdate',
          title: '更新关系',
          summary: '修改一条关系的描述',
          confirmation: {
            kind: 'edit',
            path: 'elements/relations.json',
            // 阶段 2 工具的候选原文是展示用占位符，磁盘内容里必然找不到
            oldText: '（关系字段更新，差异以执行结果为准）',
            newText: '（关系字段已更新）',
          },
        } as unknown as FileChangeConfirmationView,
        totalCount: 1,
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('修改一条关系的描述'))

    expect(wrapper.text()).not.toContain('候选原文在当前文件中已找不到')
    const agree = wrapper.findAll('button').find((item) => item.text() === '同意写入')!
    expect(agree).toBeDefined()
    expect(agree.attributes('disabled')).toBeUndefined()
    await agree.trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })
})
