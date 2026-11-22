// @vitest-environment happy-dom
/**
 * AI 写入确认面板 × CreateFile 新建不存在的文件（技能包底层能力阶段 4 OPFS 真机验收
 * 发现的死锁回归）：旧实现把 create+missing 映射成 { ok, '' }，又被草稿分支判定为
 * 「ok + create = 目标被占用」，卡片同时报「目标文件已存在」「有未保存草稿」，
 * 同意按钮禁用、重新校验也清不掉。此处锁住：目标不存在可正常同意；目标真实存在、
 * 磁盘不可读、有人工草稿时保护不被削弱。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { FileChangeConfirmationView, FileContentView } from '@novai/core/services/types'

import WriteConfirmPanel from './WriteConfirmPanel.vue'
import { setFileDraft, _clearFileDraftsForTest } from '../../composables/useFileDrafts'

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

const SKILL_PATH = 'skills/节奏压缩/SKILL.md'

function fileView(path: string, content: string): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt: 'v1' }
}

function mountCreate() {
  return mount(WriteConfirmPanel, {
    props: {
      confirmation: {
        id: 'cf-skill',
        toolName: 'CreateFile',
        title: '新建文件',
        summary: '创建技能',
        confirmation: { kind: 'create', path: SKILL_PATH, content: '# 节奏压缩\n技能正文' },
      } as unknown as FileChangeConfirmationView,
      totalCount: 1,
    },
  })
}

function agreeButton(wrapper: ReturnType<typeof mountCreate>) {
  return wrapper.findAll('button').find((item) => item.text() === '同意写入')!
}

describe('WriteConfirmPanel CreateFile 新建确认', () => {
  beforeEach(() => {
    storeState.currentProject = { id: 'p1', name: '甲项目', files: [] }
    probeFile.mockReset().mockResolvedValue({ kind: 'missing' })
    _clearFileDraftsForTest()
  })

  afterEach(() => {
    _clearFileDraftsForTest()
  })

  it('目标不存在：无冲突/草稿警告，同意按钮可点并 emit 一次 confirm', async () => {
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('技能正文'))

    expect(wrapper.text()).not.toContain('目标文件已存在')
    expect(wrapper.text()).not.toContain('未保存草稿')
    const agree = agreeButton(wrapper)
    expect(agree.attributes('disabled')).toBeUndefined()

    await agree.trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('目标文件已存在')
  })

  it('目标真实存在：仍报「目标文件已存在」，同意被禁用', async () => {
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(SKILL_PATH, '已有技能') })
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('目标文件已存在'))

    expect(agreeButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('审阅期间目标被占用：同意复检拦截，不 emit confirm', async () => {
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('技能正文'))
    probeFile.mockResolvedValue({ kind: 'ok', file: fileView(SKILL_PATH, '外部抢先创建') })

    await agreeButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.text()).toContain('目标文件已存在')
  })

  it('目标被占用后释放：重新校验清除警告并恢复可同意', async () => {
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(SKILL_PATH, '已有技能') })
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('目标文件已存在'))

    probeFile.mockResolvedValue({ kind: 'missing' })
    await wrapper.findAll('button').find((item) => item.text() === '重新校验')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('目标文件已存在')
    expect(agreeButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('目标磁盘不可读：不当作不存在放行，同意被禁用', async () => {
    probeFile.mockReset().mockResolvedValue({ kind: 'unreadable', message: '权限被拒' })
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('磁盘读取失败'))

    expect(agreeButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('目标不存在但该路径有人工草稿：草稿保护仍生效，同意被禁用', async () => {
    setFileDraft('p1', SKILL_PATH, '我的草稿', '')
    const wrapper = mountCreate()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))

    expect(agreeButton(wrapper).attributes('disabled')).toBeDefined()
  })
})
