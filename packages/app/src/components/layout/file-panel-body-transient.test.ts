// @vitest-environment happy-dom
/**
 * 文件详情临时编辑（2026-11-23 交互增补）：预览态双击正文进入临时编辑，
 * 自动保存完成（pending/saving → clean）后自动回预览——章节/要素/提示词的
 * 正文区域与卡片详情同一套快改心智。点「编辑」按钮的常规编辑保存后停在
 * 编辑态；frontmatter 卡片（有自己的点按语义）与不可编辑类型不响应双击。
 *
 * 挂载与打桩方式同 FilePanelBody.autosave.spec.ts：mock project store +
 * 记忆版草稿存储 + 受控保存器，可控时钟不靠真实等待碰运气。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { FileContentView } from '@novai/core/services/types'

import FilePanelBody from './FilePanelBody.vue'
import {
  _setDraftBackupStoreForTest,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from '../../composables/draft-backup'
import {
  EDITOR_AUTOSAVE_DEBOUNCE_MS,
  _resetEditorSessionsForTest,
  setAutosaveInputEnabled,
  setEditorProbeHandler,
  setEditorSaveHandler,
  type EditorSaveHandler,
} from '../../composables/editor-session'
import { _clearFileDraftsForTest } from '../../composables/useFileDrafts'
import { clearChangeHighlights } from '../../composables/useChangeHighlights'

vi.mock('../../stores/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/project')>()
  return {
    ...actual,
    useProjectStore: () => ({
      currentProject: { id: 'p1', name: '甲项目', files: [] },
      probeFile: vi.fn(),
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
  const format = path.endsWith('.md') ? 'markdown' : 'text'
  return { path, name: path.split('/').pop()!, format, content, updatedAt }
}

const A_PATH = 'chapters/a.txt'
const ELEMENT_PATH = 'elements/李世民.md'

describe('FilePanelBody 文件详情临时编辑', () => {
  let store: ReturnType<typeof createMemoryStore>
  let saveFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    setAutosaveInputEnabled(true)
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
    // 保存成功 = 返回落盘后的文件视图（缺 file 字段会被会话判为失败）
    saveFile = vi.fn(async (path: string, content: string) => ({
      ok: true,
      file: fileView(path, content, 'v2'),
    }))
    setEditorSaveHandler(saveFile as unknown as EditorSaveHandler)
    setEditorProbeHandler(vi.fn().mockResolvedValue({ kind: 'ok', file: fileView(A_PATH, '磁盘内容') }))
    clearChangeHighlights('p1')
  })

  afterEach(() => {
    setAutosaveInputEnabled(false)
    vi.useRealTimers()
  })

  function mountPanel(file: FileContentView, projectId = 'p1') {
    return mount(FilePanelBody, { props: { file, projectId } })
  }

  it('双击预览正文 → 临时编辑；自动保存完成 → 自动回预览', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '第一行\n第二行'))
    await wrapper.find('[data-testid="file-preview-body"]').trigger('dblclick')

    // 进入编辑态（textarea 出现），输入触发去抖自动保存
    expect(wrapper.find('textarea').exists()).toBe(true)
    await wrapper.find('textarea').setValue('双击改的内容')
    await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS + 50)
    await nextTick()

    // 落盘一次，且临时编辑自动弹回预览（textarea 消失、正文区回归）
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-preview-body"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('点「编辑」按钮的常规编辑：保存完成停在编辑态，不自动回预览', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '原文'))
    await wrapper.find('button[aria-label="编辑"]').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(true)

    await wrapper.find('textarea').setValue('常规改动')
    await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS + 50)
    await nextTick()

    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-preview-body"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('双击后不输入：状态灯亮「等待保存」，静置到期直接回预览且不触发落盘', async () => {
    const wrapper = mountPanel(fileView(A_PATH, '第一行\n第二行'))
    await wrapper.find('[data-testid="file-preview-body"]').trigger('dblclick')
    expect(wrapper.find('textarea').exists()).toBe(true)

    // 相位仍 clean（无改动）：展示层覆写为等待保存
    expect(wrapper.text()).toContain('等待保存')

    // 静置去抖同窗（2 秒）：直接回预览，未走保存链
    await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS + 50)
    await nextTick()
    expect(saveFile).not.toHaveBeenCalled()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-preview-body"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('双击 frontmatter 卡片不进入编辑；同一文件双击卡片外正文才进入', async () => {
    const wrapper = mountPanel(
      fileView(ELEMENT_PATH, '---\ntitle: 李世民\n---\n\n正文第一段'),
    )
    const card = wrapper.find('[data-testid="frontmatter-card"]')
    expect(card.exists()).toBe(true)
    await card.trigger('dblclick')
    expect(wrapper.find('textarea').exists()).toBe(false)

    await wrapper.find('[data-testid="file-preview-body"]').trigger('dblclick')
    expect(wrapper.find('textarea').exists()).toBe(true)
    wrapper.unmount()
  })

  it('不可编辑类型（rhythm/*.md 由卡片详情负责编辑）双击正文无效', async () => {
    const wrapper = mountPanel(fileView('rhythm/R-006-测试节奏卡.md', '# 测试节奏卡\n\n111'))
    await wrapper.find('[data-testid="file-preview-body"]').trigger('dblclick')
    expect(wrapper.find('textarea').exists()).toBe(false)
    wrapper.unmount()
  })
})
