// @vitest-environment happy-dom
/**
 * 非阻塞冲突与持久再入口的组件事件序（正文自动保存与并发冲突交互重设计计划 阶段 3）：
 * - AI 后台写盘到达（freezeEditorSessionForExternal）：紧凑状态条通知、不抢现场——
 *   编辑框保留草稿、不清输入、不切预览，自动保存冻结（去抖窗口到期也不写盘）；
 * - 「比较两个版本」主动展开整页比较；「返回继续编辑」收起后紧凑状态条回来，
 *   冲突未处理前再入口持久。
 *
 * 运行方式同 autosave.spec：packages/app 目录单独跑（vite.config.js 含 Vue 插件）。
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
  _resetEditorSessionsForTest,
  freezeEditorSessionForExternal,
  setAutosaveInputEnabled,
  setEditorProbeHandler,
  setEditorSaveHandler,
  type EditorSaveHandler,
} from '../../composables/editor-session'
import { _clearFileDraftsForTest } from '../../composables/useFileDrafts'

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

/** 进入编辑模式并输入草稿 */
async function editDraft(wrapper: VueWrapper, draft: string) {
  await wrapper.find('button[aria-label="编辑"]').trigger('click')
  await wrapper.find('textarea').setValue(draft)
}

describe('FilePanelBody 非阻塞冲突与再入口（阶段 3）', () => {
  let saveFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    setAutosaveInputEnabled(true)
    probeFile.mockReset().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, 'AI 后台写盘的版本', 'v9') })
    _setDraftBackupStoreForTest(createMemoryStore())
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

  it('AI 后台写盘到达：紧凑状态条非阻塞提示，编辑现场保留、自动保存冻结', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '人工未落盘草稿')

    // AI 写盘到达：冻结会话（读盘 → 冲突紧凑态，不展开）
    expect(await freezeEditorSessionForExternal('p1', A_PATH)).toBe('conflict')
    await vi.advanceTimersByTimeAsync(0)

    // 紧凑状态条出现（§五.2 文案），整页比较不出现
    expect(wrapper.text()).toContain('此文件有两个版本')
    expect(wrapper.text()).toContain('磁盘正文已被 AI 修改')
    const compareButton = wrapper.findAll('button').find((item) => item.text() === '比较两个版本')
    expect(compareButton).toBeDefined()
    expect(wrapper.text()).not.toContain('返回继续编辑')

    // 非阻塞：不清输入、不切预览，textarea 仍在且保留草稿
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('人工未落盘草稿')

    // 自动保存冻结：去抖窗口到期也不写盘（等用户在比较中明确选择）
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveFile).not.toHaveBeenCalled()

    // 冲突期间继续输入：仍保留、仍不写盘
    await wrapper.find('textarea').setValue('人工未落盘草稿（继续输入）')
    await vi.advanceTimersByTimeAsync(10_000)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('人工未落盘草稿（继续输入）')
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('「比较两个版本」展开整页比较；返回继续编辑后紧凑条回来、再入口持久', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '人工未落盘草稿')
    await freezeEditorSessionForExternal('p1', A_PATH)
    await vi.advanceTimersByTimeAsync(0)

    // 主动展开：整页比较出现，磁盘版本与人工草稿并列可见
    await wrapper.findAll('button').find((item) => item.text() === '比较两个版本')!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('返回继续编辑')
    expect(wrapper.text()).toContain('AI 后台写盘的版本')
    expect(wrapper.text()).toContain('人工未落盘草稿')
    // 展开态无紧凑状态条（同一条冲突信息的两种呈现互斥）
    expect(wrapper.findAll('button').find((item) => item.text() === '比较两个版本')).toBeUndefined()

    // 返回继续编辑：只离开冲突处理，输入与冲突状态保留
    await wrapper.findAll('button').find((item) => item.text() === '返回继续编辑')!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).not.toContain('返回继续编辑')
    // 紧凑状态条回来（再入口持久），编辑现场保留
    expect(wrapper.findAll('button').find((item) => item.text() === '比较两个版本')).toBeDefined()
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('人工未落盘草稿')

    // 冲突未处理：自动保存仍冻结
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saveFile).not.toHaveBeenCalled()
  })
})
