// @vitest-environment happy-dom
/**
 * 自动保存与离开收口的组件事件序（正文自动保存与并发冲突交互重设计计划 阶段 2）：
 * 可控时钟（vi.useFakeTimers）+ 受控写盘验证，不靠真实等待碰运气：
 * - 输入停止 2000ms 自动落盘，头部状态 等待保存 → 正在保存 → 已保存；
 * - 窗口未到即切换文件 / 编辑切回预览：立即收口，不等去抖窗口；
 * - 保存按钮已退役（无保存心智），Ctrl/⌘+S 保留为可选的立即收口；
 * - 普通失败自动补试一次，补试失败后错误持续可见、不无限重试。
 *
 * 运行方式同 attribution.spec：packages/app 目录单独跑（vite.config.js 含 Vue 插件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { FileContentView } from '@novai/core/services/types'

import FilePanelBody from './FilePanelBody.vue'
import {
  _setDraftBackupStoreForTest,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from '../../composables/draft-backup'
import {
  EDITOR_AUTOSAVE_DEBOUNCE_MS,
  EDITOR_SAVE_RETRY_DELAY_MS,
  _resetEditorSessionsForTest,
  setAutosaveInputEnabled,
  setEditorProbeHandler,
  setEditorSaveHandler,
  type EditorSaveHandler,
} from '../../composables/editor-session'
import { _clearFileDraftsForTest, getFileDraft } from '../../composables/useFileDrafts'

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

function createMemoryStore(): DraftBackupStore & { records: Map<string, PersistedDraftRecord> } {
  const records = new Map<string, PersistedDraftRecord>()
  return {
    records,
    async put(record) {
      records.set(record.key, { ...record })
    },
    async delete(key) {
      records.delete(key)
    },
    async listByProject(projectId) {
      return [...records.values()].filter((record) => record.projectId === projectId)
    },
  }
}

function fileView(path: string, content: string, updatedAt = 'v1'): FileContentView {
  return { path, name: path.split('/').pop()!, format: 'text', content, updatedAt }
}

const A_PATH = 'chapters/a.txt'
const B_PATH = 'chapters/b.txt'

/** 进入编辑模式并输入草稿 */
async function editDraft(wrapper: VueWrapper, draft: string) {
  await wrapper.find('button[aria-label="编辑"]').trigger('click')
  await wrapper.find('textarea').setValue(draft)
}

/** Ctrl/⌘+S 立即收口（快捷键是唯一手动触发，保存按钮已退役） */
async function pressSaveShortcut(wrapper: VueWrapper) {
  await wrapper.find('textarea').trigger('keydown', { ctrlKey: true, key: 's' })
}

describe('FilePanelBody 自动保存与离开收口（阶段 2）', () => {
  let store: ReturnType<typeof createMemoryStore>
  let saveFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    setAutosaveInputEnabled(true)
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, 'AI 磁盘内容') })
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
    saveFile = vi.fn()
    setEditorSaveHandler(saveFile as unknown as EditorSaveHandler)
    setEditorProbeHandler(probeFile)
  })

  afterEach(() => {
    setAutosaveInputEnabled(false)
    vi.useRealTimers()
  })

  function mountPanel(file: FileContentView, projectId = 'p1') {
    return mount(FilePanelBody, { props: { file, projectId } })
  }

  it('输入停止 2000ms 自动落盘：等待保存 → 正在保存 → 已保存，写盘带版本身份且不重复写', async () => {
    let releaseSave!: (value: { ok: true; file: FileContentView }) => void
    saveFile.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve }))
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '新输入')

    // 有待写内容即显示「等待保存」；去抖窗口内不写盘
    expect(wrapper.text()).toContain('等待保存')
    await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS - 1)
    expect(saveFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith(A_PATH, '新输入', {
      projectId: 'p1',
      expectedUpdatedAt: 'v1',
      expectedBaseHash: expect.any(String),
    })
    // 写盘在途：「正在保存」
    expect(wrapper.text()).toContain('正在保存')

    releaseSave({ ok: true, file: fileView(A_PATH, '新输入', 'v2') })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已保存')
    expect(wrapper.text()).not.toContain('等待保存')
    // 落盘后不再有多余写盘；恢复镜像清除
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveFile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(800)
    const keys = [...store.records.keys()]
    expect(keys.every((key) => !key.includes(A_PATH))).toBe(true)
  })

  it('去抖窗口未到即切换文件：旧文件立即收口落盘，新文件现场干净', async () => {
    saveFile.mockResolvedValueOnce({ ok: true, file: fileView(A_PATH, '甲草稿', 'v2') })
    const wrapper = mountPanel(fileView(A_PATH, '甲原文', 'v1'))
    await editDraft(wrapper, '甲草稿')
    await vi.advanceTimersByTimeAsync(500)

    await wrapper.setProps({ file: fileView(B_PATH, '乙原文', 's1') })
    await vi.advanceTimersByTimeAsync(0)

    // 切文件即收口：不等 2000ms 窗口，写盘归属旧路径
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith(A_PATH, '甲草稿', expect.objectContaining({ projectId: 'p1' }))
    // 甲已落盘：无待写草稿；乙现场回预览
    expect(getFileDraft('p1', A_PATH)).toBeUndefined()
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('编辑切回预览：立即收口（编辑告一段落不等去抖窗口）', async () => {
    saveFile.mockResolvedValueOnce({ ok: true, file: fileView(A_PATH, '新输入', 'v2') })
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '新输入')
    await vi.advanceTimersByTimeAsync(500)

    await wrapper.find('button[aria-label="预览"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith(A_PATH, '新输入', expect.objectContaining({ projectId: 'p1' }))
    expect(getFileDraft('p1', A_PATH)).toBeUndefined()
  })

  it('保存按钮已退役：编辑模式无「保存」按钮；Ctrl/⌘+S 仍立即收口', async () => {
    saveFile.mockResolvedValueOnce({ ok: true, file: fileView(A_PATH, '新输入', 'v2') })
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '新输入')

    expect(wrapper.findAll('button').find((item) => item.text() === '保存')).toBeUndefined()
    expect(wrapper.text()).not.toContain('Ctrl/⌘ + S 保存')

    await pressSaveShortcut(wrapper)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveFile).toHaveBeenCalledTimes(1)
  })

  it('普通失败自动补试一次：补试仍失败则错误持续可见，内容与位置保留', async () => {
    saveFile
      .mockResolvedValueOnce({ ok: false, conflict: false, message: '写入失败：权限不足' })
      .mockResolvedValueOnce({ ok: false, conflict: false, message: '写入失败：权限不足' })
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '草稿')

    await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('保存失败')
    expect(wrapper.text()).toContain('写入失败：权限不足')

    // 1000ms 后自动补试恰好一次
    await vi.advanceTimersByTimeAsync(EDITOR_SAVE_RETRY_DELAY_MS - 1)
    expect(saveFile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveFile).toHaveBeenCalledTimes(2)

    // 补试也失败：不再自动重试，错误持续可见、草稿保留
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveFile).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('保存失败')
    expect(getFileDraft('p1', A_PATH)).toBe('草稿')
  })
})
