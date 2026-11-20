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
  setEditorGuard,
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

/** 章节形态测试文本：一段一行、段间空行，中段段落内少量润色 */
const CHAPTER_LINES = [
  '第一段：夜色渐深，城门外的官道上已经没有行人。',
  '',
  '第二段：夜色像一张巨大的幕布缓缓压下来，远处的山脊只剩下一道模糊的剪影。',
  '',
  '第三段：他收剑入鞘，转身走进了那条无人的长街。',
]
const AI_POLISHED_LINES = CHAPTER_LINES.map((line) =>
  line === CHAPTER_LINES[2]
    ? '第二段：夜色像一张沉重的幕布缓缓压下来，远处的山脊只剩下一道朦胧的剪影。'
    : line,
)

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

  it('比较视图为单栏差异块：中文润色只突出变化的字、未改动区折叠可展开', async () => {
    probeFile.mockResolvedValue({
      kind: 'ok',
      file: fileView(A_PATH, AI_POLISHED_LINES.join('\n'), 'v9'),
    })
    const wrapper = mountPanel(fileView(A_PATH, CHAPTER_LINES.join('\n'), 'v1'))
    await editDraft(wrapper, CHAPTER_LINES.map((l, i) => (i === 2 ? `${l}（人工续写）` : l)).join('\n'))

    await freezeEditorSessionForExternal('p1', A_PATH)
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.findAll('button').find((item) => item.text() === '比较两个版本')!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // 概览按段计数：只有 1 段修改（人工续写落在同一段 → 与 AI 润色同段对改）
    expect(wrapper.text()).toContain('修改 1 段')

    // 字级高亮：原段落加深被替换的字（红系），新段落加深 AI 的字（绿系）
    const delStrong = wrapper.findAll('.conflict-inline-del')
    const addStrong = wrapper.findAll('.conflict-inline-add')
    expect(delStrong.length).toBeGreaterThan(0)
    expect(addStrong.length).toBeGreaterThan(0)
    expect(delStrong.map((s) => s.text()).join('')).toContain('巨大')
    expect(addStrong.map((s) => s.text()).join('')).toContain('沉重')
    // 未变化的字留在普通段（same 段不以 strong 类呈现）
    expect(wrapper.find('.conflict-para-del').text()).toContain('幕布缓缓压下来')

    // 未改动段保留上下文（首尾段落灰显可见），不出现旧双栏空白占位口径
    expect(wrapper.text()).toContain('第一段：夜色渐深')
    expect(wrapper.text()).not.toContain('草稿独有')

    // 折叠区：章节中间的空行等未改动区不构成折叠（行数低于阈值），此用例文本较短
    // 应无折叠按钮；长文折叠由 conflict-diff 单测覆盖结构、此处只验证不误伤短文
    const foldButtons = wrapper.findAll('button').filter((b) => b.text().includes('未改动内容'))
    expect(foldButtons).toHaveLength(0)
  })

  it('长章节比较视图：未改动区折叠，点击展开后可再收起', async () => {
    const longLines = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：保持原样。`)
    probeFile.mockResolvedValue({
      kind: 'ok',
      file: fileView(A_PATH, longLines.map((l, i) => (i === 9 ? '第十段：AI 润色。' : l)).join('\n'), 'v9'),
    })
    const wrapper = mountPanel(fileView(A_PATH, longLines.join('\n'), 'v1'))
    await editDraft(wrapper, longLines.map((l, i) => (i === 9 ? `${l}（人工改）` : l)).join('\n'))

    await freezeEditorSessionForExternal('p1', A_PATH)
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.findAll('button').find((item) => item.text() === '比较两个版本')!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // 文首 6 段折叠；展开前不可见第1段，展开后可见并可再收起
    const foldButton = wrapper.findAll('button').find((b) => b.text().includes('展开 6 段未改动内容'))
    expect(foldButton).toBeDefined()
    expect(wrapper.text()).not.toContain('第1段：保持原样。')

    await foldButton!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('第1段：保持原样。')
    const collapseButton = wrapper.findAll('button').find((b) => b.text().includes('收起 6 段未改动内容'))
    expect(collapseButton).toBeDefined()

    await collapseButton!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).not.toContain('第1段：保持原样。')
  })

  it('冲突展开后进入删除守护：守护横幅与「恢复为草稿副本/放弃」出口仍在（消息区常驻）', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '原文', 'v1'))
    await editDraft(wrapper, '人工未落盘草稿')
    await freezeEditorSessionForExternal('p1', A_PATH)
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.findAll('button').find((item) => item.text() === '比较两个版本')!.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('返回继续编辑')

    // 冲突已展开时守护到达（会话已有未落盘内容）：横幅与出口不得随冲突展开消失
    setEditorGuard('p1', A_PATH, { kind: 'deleted', trashPath: '.trash/chapters/a.txt' })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('已被 AI 删除并移入回收站')
    expect(wrapper.text()).toContain('.trash/chapters/a.txt')
    const restore = wrapper.findAll('button').find((item) => item.text() === '恢复为草稿副本')
    const discard = wrapper.findAll('button').find((item) => item.text() === '放弃草稿并关闭')
    expect(restore).toBeDefined()
    expect(discard).toBeDefined()
    // 冲突比较与四出口同屏在场（同一条会话的两种提示互不挤掉）
    expect(wrapper.find('[data-testid="detail-conflict-resolution"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('AI 后台写盘的版本')
  })
})
