// @vitest-environment happy-dom
/**
 * 保存身份修复的组件事件序测试（正文自动保存与并发冲突交互重设计计划 §四.4）：
 * 保存成功后 store 用新文件对象回写同路径——「同路径磁盘版本更新」必须与
 * 「切换到另一个文件」「同路径切换到另一个项目」是三个不同事件：
 * - 同路径回写不重置编辑态、不清冲突再入口与保存错误（2026-11-08 真机缺陷）；
 * - 真实切文件/切项目仍要重置视图并换会话桶。
 *
 * 运行方式同 attribution.spec：packages/app 目录单独跑（vite.config.js 含 Vue 插件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { FileContentView } from '@novai/core/services/types'

import FilePanelBody from './FilePanelBody.vue'
import { getFileDraft, _clearFileDraftsForTest } from '../../composables/useFileDrafts'
import {
  setEditorProbeHandler,
  setEditorSaveHandler,
  _resetEditorSessionsForTest,
} from '../../composables/editor-session'

const probeFile = vi.hoisted(() => vi.fn())

vi.mock('../../stores/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/project')>()
  return {
    ...actual,
    useProjectStore: () => ({
      currentProject: { id: 'p1', name: '甲项目', files: [] },
      probeFile,
      createFileCopy: vi.fn(),
      refreshTree: vi.fn(),
      openFile: vi.fn(),
    }),
  }
})

function fileView(path: string, content: string, updatedAt = 'v1'): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt }
}

function button(wrapper: VueWrapper, text: string) {
  const match = wrapper.findAll('button').find((item) => item.text() === text)
  if (!match) throw new Error(`找不到按钮：${text}`)
  return match
}

const A_PATH = 'chapters/a.txt'

/** 进入编辑模式并输入草稿 */
async function editDraft(wrapper: VueWrapper, draft: string) {
  await wrapper.find('button[aria-label="编辑"]').trigger('click')
  await wrapper.find('textarea').setValue(draft)
}

/** Ctrl/⌘+S 立即收口（保存按钮已随无保存心智退役，快捷键是唯一手动触发） */
async function pressSaveShortcut(wrapper: VueWrapper) {
  await wrapper.find('textarea').trigger('keydown', { ctrlKey: true, key: 's' })
}

/** 制造一次保存冲突并回到编辑态（冲突再入口出现） */
async function enterConflictAndReturn(wrapper: VueWrapper, saveFile: ReturnType<typeof vi.fn>, draft: string) {
  saveFile.mockResolvedValueOnce({ ok: false, conflict: true, message: '磁盘已被外部修改' })
  await editDraft(wrapper, draft)
  await pressSaveShortcut(wrapper)
  await vi.waitFor(() => expect(wrapper.text()).toContain('保存冲突'))
  await button(wrapper, '返回继续编辑').trigger('click')
}

describe('FilePanelBody 保存身份（同路径回写 ≠ 切换文件）', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容', 'v2') })
  })

  it('保存成功回写同路径新文件对象：不退预览、不清冲突再入口、草稿保留', async () => {
    const saveFile = vi.fn()
    setEditorSaveHandler(saveFile)
    setEditorProbeHandler(probeFile)
    const wrapper = mount(FilePanelBody, {
      props: { file: fileView(A_PATH, '原文'), projectId: 'p1' },
    })
    await enterConflictAndReturn(wrapper, saveFile, '我的草稿')
    // 冲突再入口存在（编辑态）
    expect(wrapper.text()).toContain('比较两个版本')

    // store 在保存成功后用「同路径、新对象、新版本」替换 activeFile（真实回写形态）
    await wrapper.setProps({ file: fileView(A_PATH, '我的草稿', 'v2') })
    await flushPromises()

    // 不退预览：编辑现场保留
    expect(wrapper.find('textarea').exists()).toBe(true)
    // 冲突再入口未被清
    expect(wrapper.text()).toContain('比较两个版本')
    // 草稿仍在
    expect(getFileDraft('p1', A_PATH)).toBe('我的草稿')
  })

  it('在途写盘晚到成功回写同路径对象：新输入保留、冲突不因晚到成功解除', async () => {
    const saveFile = vi.fn()
    setEditorSaveHandler(saveFile)
    setEditorProbeHandler(probeFile)
    const wrapper = mount(FilePanelBody, {
      props: { file: fileView(A_PATH, '原文'), projectId: 'p1' },
    })
    await enterConflictAndReturn(wrapper, saveFile, '原草稿')

    let releaseSave!: (value: { ok: true; file: FileContentView }) => void
    saveFile.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve }),
    )
    await pressSaveShortcut(wrapper)
    // 写盘在途时继续输入（不被清除、不误判已保存）
    await wrapper.find('textarea').setValue('在途期间的新输入')
    releaseSave({ ok: true, file: fileView(A_PATH, '原草稿', 'v2') })
    await flushPromises()

    expect(getFileDraft('p1', A_PATH)).toBe('在途期间的新输入')
    // 冲突不因旧写晚到成功而解除（再入口仍在）
    expect(wrapper.text()).toContain('比较两个版本')
  })

  it('真实切换到另一个文件：视图重置回预览、草稿按路径隔离保留', async () => {
    const saveFile = vi.fn()
    setEditorSaveHandler(saveFile)
    setEditorProbeHandler(probeFile)
    const wrapper = mount(FilePanelBody, {
      props: { file: fileView(A_PATH, '原文'), projectId: 'p1' },
    })
    await enterConflictAndReturn(wrapper, saveFile, '甲草稿')

    await wrapper.setProps({ file: fileView('chapters/b.txt', '乙原文') })
    await flushPromises()

    // 切文件重置编辑态
    expect(wrapper.find('textarea').exists()).toBe(false)
    // 甲的冲突再入口不在乙文件现场（按路径隔离），甲草稿保留
    expect(wrapper.text()).not.toContain('比较两个版本')
    expect(getFileDraft('p1', A_PATH)).toBe('甲草稿')
  })

  it('同路径切换到另一个项目：换会话桶，旧项目状态不冒充新项目现场', async () => {
    const saveFile = vi.fn()
    setEditorSaveHandler(saveFile)
    setEditorProbeHandler(probeFile)
    const wrapper = mount(FilePanelBody, {
      props: { file: fileView(A_PATH, '甲原文'), projectId: 'p1' },
    })
    await enterConflictAndReturn(wrapper, saveFile, '甲草稿')

    await wrapper.setProps({ file: fileView(A_PATH, '乙原文'), projectId: 'p2' })
    await flushPromises()

    // 乙项目现场没有甲项目的冲突再入口
    expect(wrapper.text()).not.toContain('比较两个版本')
    expect(getFileDraft('p1', A_PATH)).toBe('甲草稿')
    // 乙项目路径上没有草稿
    expect(getFileDraft('p2', A_PATH)).toBeUndefined()
  })
})
