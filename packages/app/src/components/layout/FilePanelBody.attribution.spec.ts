// @vitest-environment happy-dom
/**
 * 保存冲突面板的归属返修（数据安全计划 §3-1/§3-6 组件面）：
 * 根 vitest 配置无 Vue SFC 插件（共享配置不动），本文件用 .spec.ts 避开根
 * include（*.test.ts），由 packages/app 目录（vite.config.js 含 @vitejs/plugin-vue）
 * 单独运行：pnpm --filter @novai/app exec vitest run src/components/layout
 *
 * 覆盖：冲突读取晚到不污染切走后的现场；有损采用固定项目；「采用 AI 版本」
 * 读取失败不删草稿；空草稿可另存副本；读取失败不提供有损采用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { FileContentView } from '@novai/core/services/types'

import FilePanelBody from './FilePanelBody.vue'
import { getFileDraft, getFileDraftEntry, _clearFileDraftsForTest } from '../../composables/useFileDrafts'
import {
  setEditorProbeHandler,
  setEditorSaveHandler,
  type EditorSaveHandler,
  _resetEditorSessionsForTest,
} from '../../composables/editor-session'

const probeFile = vi.hoisted(() => vi.fn())
const createFileCopy = vi.hoisted(() => vi.fn())

vi.mock('../../stores/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/project')>()
  return {
    ...actual,
    useProjectStore: () => ({
      currentProject: { id: 'p1', name: '甲项目', files: [] },
      probeFile,
      createFileCopy,
      refreshTree: vi.fn(),
      openFile: vi.fn(),
    }),
  }
})

function fileView(path: string, content: string): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt: 'v1' }
}

function button(wrapper: VueWrapper, text: string) {
  const match = wrapper.findAll('button').find((item) => item.text() === text)
  if (!match) throw new Error(`找不到按钮：${text}`)
  return match
}

function buttonIncluding(wrapper: VueWrapper, text: string) {
  const match = wrapper.findAll('button').find((item) => item.text().includes(text))
  if (!match) throw new Error(`找不到按钮：${text}`)
  return match
}

const A_PATH = 'chapters/a.txt'

/** 进入编辑模式并输入草稿（editDraft watch 自动入草稿表） */
async function editDraft(wrapper: VueWrapper, draft: string) {
  await wrapper.find('button[aria-label="编辑"]').trigger('click')
  await wrapper.find('textarea').setValue(draft)
}

/** Ctrl/⌘+S 立即收口（保存按钮已随无保存心智退役，快捷键是唯一手动触发） */
async function pressSaveShortcut(wrapper: VueWrapper) {
  await wrapper.find('textarea').trigger('keydown', { ctrlKey: true, key: 's' })
}

/** 触发一次冲突保存并等冲突界面出现 */
async function openConflict(
  wrapper: VueWrapper,
  saveFile: ReturnType<typeof vi.fn>,
  draft: string,
) {
  saveFile.mockResolvedValueOnce({ ok: false, conflict: true, message: '磁盘已被外部修改' })
  await editDraft(wrapper, draft)
  await pressSaveShortcut(wrapper)
  await vi.waitFor(() => expect(wrapper.text()).toContain('此文件有两个版本'))
}

describe('FilePanelBody 保存冲突归属返修', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
    createFileCopy.mockReset().mockResolvedValue({ ok: true, file: fileView('chapters/copy.txt', '') })
  })

  /** 挂载面板并注册保存/探测服务（会话编排经注入服务调用，不再走 props） */
  function mountPanel(props: { file: FileContentView; projectId: string }, saveFile: ReturnType<typeof vi.fn>) {
    setEditorSaveHandler(saveFile as unknown as EditorSaveHandler)
    setEditorProbeHandler(probeFile)
    return mount(FilePanelBody, { props })
  }

  it('冲突探测未完成时切到乙文件：晚到结果不弹冲突界面，甲草稿保留', async () => {
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    saveFile.mockResolvedValueOnce({ ok: false, conflict: true, message: '磁盘已被外部修改' })
    await editDraft(wrapper, '我的草稿')

    let releaseProbe!: (value: { kind: 'ok'; file: FileContentView }) => void
    probeFile.mockImplementationOnce(
      () => new Promise((resolve) => { releaseProbe = resolve }),
    )
    await pressSaveShortcut(wrapper)
    // 保存冲突已判定、磁盘探测在途时切到乙文件（代次递增）
    await wrapper.setProps({ file: fileView('chapters/b.txt', '乙原文') })
    releaseProbe({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
    await flushPromises()

    expect(wrapper.text()).not.toContain('此文件有两个版本')
    // 甲的草稿仍在草稿表，未被切走丢失
    expect(getFileDraft('p1', A_PATH)).toBe('我的草稿')
  })

  it('「采用我的草稿」仍写入冲突启动时固定的项目', async () => {
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '我的草稿')
    // 主保存带版本校验与项目；强制采用整份覆盖
    expect(saveFile).toHaveBeenNthCalledWith(1, A_PATH, '我的草稿', {
      projectId: 'p1',
      expectedUpdatedAt: 'v1',
      expectedBaseHash: expect.any(String),
    })

    saveFile.mockResolvedValueOnce({ ok: true, file: fileView(A_PATH, '我的草稿') })
    await button(wrapper, '采用我的草稿').trigger('click')
    await buttonIncluding(wrapper, '确认覆盖磁盘').trigger('click')
    await flushPromises()

    expect(saveFile).toHaveBeenLastCalledWith(A_PATH, '我的草稿', { force: true, projectId: 'p1' })
    expect(wrapper.text()).not.toContain('此文件有两个版本')
  })

  it('「采用 AI 版本」复检读取失败：不删草稿，回到冲突界面呈现读取失败', async () => {
    probeFile
      .mockResolvedValueOnce({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
      .mockResolvedValueOnce({ kind: 'unreadable', message: '权限失效' })
      .mockResolvedValueOnce({ kind: 'unreadable', message: '权限失效' })
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '必须保留的草稿')

    await button(wrapper, '采用 AI 版本').trigger('click')
    await buttonIncluding(wrapper, '确认放弃草稿').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('磁盘读取失败：权限失效'))

    // 读取失败绝不丢稿：草稿仍在，有损采用出口隐藏
    expect(getFileDraft('p1', A_PATH)).toBe('必须保留的草稿')
    const adoptDisk = wrapper.findAll('button').find((item) => item.text().includes('采用 AI 版本'))
    expect(adoptDisk).toBeUndefined()
  })

  it('同路径跨项目后立即输入：草稿写入新项目，不回写旧项目或使用旧基线', async () => {
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '甲原文'), projectId: 'p1' }, saveFile)
    await editDraft(wrapper, '甲草稿')
    await wrapper.setProps({ file: fileView(A_PATH, '乙原文'), projectId: 'p2' })
    await wrapper.find('button[aria-label="编辑"]').trigger('click')
    await wrapper.find('textarea').setValue('乙项目的新草稿')

    expect(getFileDraft('p1', A_PATH)).toBe('甲草稿')
    expect(getFileDraft('p2', A_PATH)).toBe('乙项目的新草稿')
    expect(getFileDraftEntry('p2', A_PATH)?.baseContent).toBe('乙原文')
  })

  it('同路径跨项目保存：旧项目晚到不显示为新项目的保存中或冲突', async () => {
    let releaseSave!: (value: { ok: false; conflict: boolean; message: string }) => void
    const saveFile = vi.fn().mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve }),
    )
    const wrapper = mountPanel({ file: fileView(A_PATH, '甲原文'), projectId: 'p1' }, saveFile)
    await editDraft(wrapper, '甲草稿')
    await pressSaveShortcut(wrapper)
    expect(wrapper.text()).toContain('正在保存')

    await wrapper.setProps({ file: fileView(A_PATH, '乙原文'), projectId: 'p2' })
    expect(wrapper.text()).toContain('已保存')
    releaseSave({ ok: false, conflict: true, message: '甲项目冲突' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('甲项目冲突')
    expect(wrapper.text()).toContain('已保存')
  })

  it('「采用 AI 版本」复检在途时用户返回编辑：不得清掉后来继续输入的草稿', async () => {
    let releaseProbe!: (value: { kind: 'ok'; file: FileContentView }) => void
    probeFile
      .mockResolvedValueOnce({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseProbe = resolve }))
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '原草稿')

    await button(wrapper, '采用 AI 版本').trigger('click')
    await buttonIncluding(wrapper, '确认放弃草稿').trigger('click')
    await button(wrapper, '返回继续编辑').trigger('click')
    await wrapper.find('textarea').setValue('后来继续输入的新草稿')
    releaseProbe({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
    await flushPromises()

    expect(getFileDraft('p1', A_PATH)).toBe('后来继续输入的新草稿')
  })

  it('「采用我的草稿」写盘在途时继续输入：旧成功结果保留新稿与冲突再入口', async () => {
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '原草稿')
    let releaseSave!: (value: { ok: true; file: FileContentView }) => void
    saveFile.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve }))
    await button(wrapper, '采用我的草稿').trigger('click')
    await buttonIncluding(wrapper, '确认覆盖磁盘').trigger('click')
    await button(wrapper, '返回继续编辑').trigger('click')
    await wrapper.find('textarea').setValue('后来继续输入的新草稿')
    releaseSave({ ok: true, file: fileView(A_PATH, '原草稿') })
    await flushPromises()

    expect(getFileDraft('p1', A_PATH)).toBe('后来继续输入的新草稿')
    expect(wrapper.text()).toContain('比较两个版本')
  })

  it('磁盘读取失败的冲突不提供任何有损采用，草稿保留', async () => {
    probeFile.mockResolvedValue({ kind: 'unreadable', message: '权限失效' })
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '必须保留的草稿')

    expect(wrapper.text()).toContain('磁盘读取失败：权限失效')
    expect(wrapper.findAll('button').find((item) => item.text().includes('采用 AI 版本'))).toBeUndefined()
    expect(wrapper.findAll('button').find((item) => item.text().includes('采用我的草稿'))).toBeUndefined()
    expect(getFileDraft('p1', A_PATH)).toBe('必须保留的草稿')
    // 安全出口仍在：返回编辑与另存副本
    expect(button(wrapper, '返回继续编辑')).toBeTruthy()
    expect(button(wrapper, '将草稿另存为副本')).toBeTruthy()
  })

  it('删除全部正文的空草稿也可另存为副本（写入固定项目）', async () => {
    const saveFile = vi.fn()
    const wrapper = mountPanel({ file: fileView(A_PATH, '原文'), projectId: 'p1' }, saveFile)
    await openConflict(wrapper, saveFile, '')

    await button(wrapper, '将草稿另存为副本').trigger('click')
    await wrapper.find('input').setValue('chapters/copy.txt')
    await button(wrapper, '保存副本').trigger('click')
    await vi.waitFor(() =>
      expect(createFileCopy).toHaveBeenCalledWith('chapters/copy.txt', '', { projectId: 'p1' }),
    )
  })
})
