// @vitest-environment happy-dom
/**
 * AI 写入确认面板的归属返修（数据安全计划 §3-5/F6-F7 组件面）：
 * 与 FilePanelBody.attribution.spec.ts 同理用 .spec.ts 避开根配置，由
 * packages/app 目录单独运行。
 *
 * 覆盖：有草稿/读取失败阻止直接同意；保存草稿固定项目且跨项目晚到不清
 * 新项目草稿；探测晚到不污染切走后的确认；「文件不存在」的仍要同意必须
 * 复检仍不存在才放行。
 * 阶段 4 追加：「保存草稿后重审」走统一保存会话（不再强写）、冲突未解决
 * 不能同意、复检等在途自动保存落盘、副本二次确认只清操作开始时快照。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { FileChangeConfirmationView, FileContentView } from '@novai/core/services/types'

import WriteConfirmPanel from './WriteConfirmPanel.vue'
import { getFileDraft, setFileDraft, _clearFileDraftsForTest } from '../../composables/useFileDrafts'
import { requestEditorSave, setEditorSaveHandler, type EditorSaveHandler } from '../../composables/editor-session'

const storeState = vi.hoisted(() => ({
  currentProject: null as { id: string; name: string; files: never[] } | null,
}))
const probeFile = vi.hoisted(() => vi.fn())
const saveFile = vi.hoisted(() => vi.fn())
const createFileCopy = vi.hoisted(() => vi.fn())
const refreshTree = vi.hoisted(() => vi.fn())

vi.mock('../../stores/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/project')>()
  return {
    ...actual,
    useProjectStore: () => ({
      get currentProject() {
        return storeState.currentProject
      },
      probeFile,
      saveFile,
      createFileCopy,
      refreshTree,
    }),
  }
})

const A_PATH = 'chapters/a.txt'
const DISK = '开头 旧段 结尾'

function fileView(path: string, content: string): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt: 'v1' }
}

function confirmation(id: string, path: string): FileChangeConfirmationView {
  return {
    id,
    toolName: 'edit_file',
    title: '修改正文',
    summary: '替换一段文字',
    confirmation: { kind: 'edit', path, oldText: '旧段', newText: '新段' },
  } as unknown as FileChangeConfirmationView
}

function button(wrapper: VueWrapper, text: string) {
  const match = wrapper.findAll('button').find((item) => item.text() === text)
  if (!match) throw new Error(`找不到按钮：${text}`)
  return match
}

function mountPanel(confirmationId = 'cf-1', path = A_PATH) {
  return mount(WriteConfirmPanel, {
    props: { confirmation: confirmation(confirmationId, path), totalCount: 1 },
  })
}

describe('WriteConfirmPanel 确认归属返修', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    storeState.currentProject = { id: 'p1', name: '甲项目', files: [] }
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, DISK) })
    saveFile.mockReset()
    createFileCopy.mockReset()
    refreshTree.mockReset()
    // 阶段 4：保存草稿走统一保存会话（save handler 注入）
    setEditorSaveHandler(saveFile as unknown as EditorSaveHandler)
  })

  afterEach(() => {
    setEditorSaveHandler(null)
  })

  it('目标文件有人工草稿：进入草稿分支横幅，直接同意被阻止', async () => {
    setFileDraft('p1', A_PATH, '我的草稿', DISK)
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))
    expect(button(wrapper, '同意写入').attributes('disabled')).toBeDefined()
  })

  it('磁盘读取失败：与不存在分开提示，无「仍要同意」出口且不能同意', async () => {
    probeFile.mockResolvedValue({ kind: 'unreadable', message: '权限失效' })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('磁盘读取失败：权限失效'))
    expect(wrapper.text()).not.toContain('目标文件在磁盘上已不存在')
    expect(wrapper.findAll('button').find((item) => item.text().includes('仍要同意'))).toBeUndefined()
    expect(button(wrapper, '同意写入').attributes('disabled')).toBeDefined()
  })

  it('「保存草稿后重审」固定原项目；跨项目晚到不清新项目同路径草稿', async () => {
    setFileDraft('p1', A_PATH, '我的草稿', DISK)
    setFileDraft('p2', A_PATH, '乙项目草稿', DISK)
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))

    let releaseSave!: (value: { ok: true; file: FileContentView }) => void
    saveFile.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve }),
    )
    await button(wrapper, '保存草稿后重审').trigger('click')
    // 写盘在途切到乙项目：草稿清除仍固定甲
    storeState.currentProject = { id: 'p2', name: '乙项目', files: [] }
    releaseSave({ ok: true, file: fileView(A_PATH, '我的草稿') })
    await flushPromises()
    await flushPromises()

    expect(saveFile).toHaveBeenCalledWith(A_PATH, '我的草稿', expect.objectContaining({ projectId: 'p1' }))
    expect(getFileDraft('p1', A_PATH)).toBeUndefined()
    expect(getFileDraft('p2', A_PATH)).toBe('乙项目草稿')
  })

  it('保存草稿后重审的在途写盘：完成回调不得清掉后来更新的草稿', async () => {
    setFileDraft('p1', A_PATH, '保存开始时的草稿', DISK)
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))
    let releaseSave!: (value: { ok: true; file: FileContentView }) => void
    saveFile.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve }))
    await button(wrapper, '保存草稿后重审').trigger('click')
    setFileDraft('p1', A_PATH, '等待期间继续输入的新草稿', DISK)
    releaseSave({ ok: true, file: fileView(A_PATH, '保存开始时的草稿') })
    await flushPromises()
    await flushPromises()

    expect(getFileDraft('p1', A_PATH)).toBe('等待期间继续输入的新草稿')
  })

  it('甲确认探测在途时切到乙确认：晚到结果不进入乙预览', async () => {
    let releaseA!: (value: { kind: 'ok'; file: FileContentView }) => void
    let releaseB!: (value: { kind: 'ok'; file: FileContentView }) => void
    probeFile
      .mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseB = resolve }))
    const wrapper = mountPanel('cf-1', A_PATH)
    // 甲的探测挂起时切到乙确认（不同确认、不同路径）
    await wrapper.setProps({ confirmation: confirmation('cf-2', 'chapters/b.txt'), totalCount: 1 })
    releaseA({ kind: 'ok', file: fileView(A_PATH, '甲磁盘独有内容') })
    await flushPromises()

    expect(wrapper.text()).not.toContain('甲磁盘独有内容')
    // 收尾乙的挂起探测，避免测试残留
    releaseB({ kind: 'ok', file: fileView('chapters/b.txt', DISK) })
    await flushPromises()
  })

  it('确认 id 复用但目标路径变化：旧路径探测不得进入新路径预览', async () => {
    let releaseA!: (value: { kind: 'ok'; file: FileContentView }) => void
    let releaseB!: (value: { kind: 'ok'; file: FileContentView }) => void
    probeFile
      .mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseB = resolve }))
    const wrapper = mountPanel('cf-reused', A_PATH)
    await wrapper.setProps({ confirmation: confirmation('cf-reused', 'chapters/b.txt'), totalCount: 1 })
    await vi.waitFor(() => expect(releaseB).toBeTypeOf('function'))
    releaseA({ kind: 'ok', file: fileView(A_PATH, '旧路径独有内容') })
    await flushPromises()

    expect(wrapper.text()).not.toContain('旧路径独有内容')
    releaseB({ kind: 'ok', file: fileView('chapters/b.txt', '旧段 新路径内容') })
    await vi.waitFor(() => expect(wrapper.text()).toContain('新路径内容'))
  })

  it('最终复检等待期间新出现人工草稿：不得按初始无草稿快照放行', async () => {
    let releaseProbe!: (value: { kind: 'ok'; file: FileContentView }) => void
    probeFile
      .mockResolvedValueOnce({ kind: 'ok', file: fileView(A_PATH, DISK) })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseProbe = resolve }))
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('新段'))
    await button(wrapper, '同意写入').trigger('click')
    setFileDraft('p1', A_PATH, '等待期间的新草稿', DISK)
    // 复检先等在途保存链 settle，再探测磁盘：等探测真正挂起再放行
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'))
    releaseProbe({ kind: 'ok', file: fileView(A_PATH, DISK) })
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容')
    expect(getFileDraft('p1', A_PATH)).toBe('等待期间的新草稿')
  })

  it('新建目标在最终复检时已存在：拦截同意并显示占用提示', async () => {
    const wrapper = mount(WriteConfirmPanel, {
      props: {
        confirmation: {
          id: 'cf-create',
          toolName: 'create_file',
          title: '新建正文',
          summary: '创建一份正文',
          confirmation: { kind: 'create', path: A_PATH, content: '新文件' },
        } as unknown as FileChangeConfirmationView,
        totalCount: 1,
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('新文件'))
    await button(wrapper, '同意写入').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.text()).toContain('目标文件已存在')
  })

  it('「文件不存在」的仍要同意走复检：仍不存在才放行一次 confirm', async () => {
    probeFile
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'missing' })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('目标文件在磁盘上已不存在'))

    await button(wrapper, '仍要同意（以工具结果为准）').trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('无草稿且版本一致：同意写入复检通过后放行', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('同意写入'))
    await button(wrapper, '同意写入').trigger('click')
    await flushPromises()

    expect(probeFile).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })
})

describe('WriteConfirmPanel 确认链接入统一保存会话（阶段 4）', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    storeState.currentProject = { id: 'p1', name: '甲项目', files: [] }
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, DISK) })
    saveFile.mockReset()
    createFileCopy.mockReset().mockResolvedValue({ ok: true, path: 'chapters/副本.txt' })
    refreshTree.mockReset()
    setEditorSaveHandler(saveFile as unknown as EditorSaveHandler)
  })

  afterEach(() => {
    setEditorSaveHandler(null)
  })

  it('「保存草稿后重审」磁盘已变：撞版本校验进冲突，不强写、草稿保留', async () => {
    setFileDraft('p1', A_PATH, '我的草稿', DISK)
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))

    saveFile.mockResolvedValueOnce({ ok: false, conflict: true, message: '已被外部修改' })
    await button(wrapper, '保存草稿后重审').trigger('click')
    await flushPromises()
    await flushPromises()

    // 强写已移除：不带 force，撞校验即进冲突（§五.4）
    expect(saveFile).toHaveBeenCalledWith(A_PATH, '我的草稿', expect.not.objectContaining({ force: true }))
    expect(wrapper.text()).toContain('已进入两个版本比较')
    // 草稿保留：等用户在正文面板完成版本选择
    expect(getFileDraft('p1', A_PATH)).toBe('我的草稿')
  })

  it('冲突未解决时同意被拦：不两套面板各自强写', async () => {
    setFileDraft('p1', A_PATH, '我的草稿', DISK)
    // 直接把会话置为冲突态（AI 先落盘冻结的等价现场：保存再撞也进冲突）
    saveFile.mockResolvedValue({ ok: false, conflict: true, message: '已被外部修改' })
    await requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await flushPromises()

    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))
    // 「同意写入」被阻止（disabled）；草稿分支内没有绕过出口
    expect(button(wrapper, '同意写入').attributes('disabled')).toBeDefined()

    // 冲突未解决前「保存草稿后重审」再撞版本校验：同样进冲突、提示先完成版本选择
    await button(wrapper, '保存草稿后重审').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(saveFile).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('已进入两个版本比较')
    expect(getFileDraft('p1', A_PATH)).toBe('我的草稿')
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('保存草稿后重审成功：草稿清除回到可直接同意，复检放行', async () => {
    setFileDraft('p1', A_PATH, '我的草稿', DISK)
    saveFile.mockResolvedValueOnce({ ok: true, file: fileView(A_PATH, '我的草稿') })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))

    await button(wrapper, '保存草稿后重审').trigger('click')
    await flushPromises()
    await flushPromises()
    // 统一保存会话落盘成功：草稿清除、横幅回无草稿分支
    expect(getFileDraft('p1', A_PATH)).toBeUndefined()
    await vi.waitFor(() => expect(button(wrapper, '同意写入').attributes('disabled')).toBeUndefined())

    await button(wrapper, '同意写入').trigger('click')
    await flushPromises()
    // 初次加载 + 保存后重读 + 同意前复检
    expect(probeFile).toHaveBeenCalledTimes(3)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('另存副本需二次确认；成功只清操作开始时的快照、等待期间新增输入保留', async () => {
    setFileDraft('p1', A_PATH, '保存副本时的草稿', DISK)
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain('这个文件有你尚未写入正文的内容'))

    await button(wrapper, '另存副本后放弃当前内容').trigger('click')
    await wrapper.find('input[placeholder="副本文件路径"]').setValue('chapters/副本.txt')
    // 第一击只是二次确认（明确「原文件内容仍未写完」），不落盘
    await button(wrapper, '保存副本').trigger('click')
    expect(createFileCopy).not.toHaveBeenCalled()
    expect(button(wrapper, '确认另存（原文件内容仍未写完）')).toBeDefined()

    // 等待期间继续输入（快照固定为点击时刻的草稿）
    setFileDraft('p1', A_PATH, '等待期间继续输入', DISK)
    await button(wrapper, '确认另存（原文件内容仍未写完）').trigger('click')
    await flushPromises()

    expect(createFileCopy).toHaveBeenCalledWith('chapters/副本.txt', '保存副本时的草稿', { projectId: 'p1' })
    // 只清快照：新增输入保留进入重审（不被一并删除）
    expect(getFileDraft('p1', A_PATH)).toBe('等待期间继续输入')
    expect(wrapper.text()).toContain('已另存副本：chapters/副本.txt')
  })
})
