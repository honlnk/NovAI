// @vitest-environment happy-dom
/**
 * 冲突反馈分层真实事件链（修复批 2026-11-20，正文自动保存计划修复批验收）：
 * 走生产同一条链——chatStore.recentFileChanges 入账 → useFileChangeFeedback 的
 * watch 消费 → freezeEditorSessionForExternal / useChangeHighlights / useToast
 * 模块态全部真实，仅 stores/project 打桩（openFile/probeFile 等服务面）。
 *
 * 断言口径（修复批目标；变更通知队列已于 2026-11-23 按用户决策移除）：
 * - 人工正编辑同一文件（dirty）时 AI 连续多次修改（每次新 recordId）：黄色冲突条
 *   唯一（会话单 conflict、generation 递增、磁盘快照跟随最后一次 AI 版本）、
 *   冲突 toast 为零；变更账本不被清理；
 * - 非当前文件的首次冲突：仅一次 toast 指路，后续修改静默；
 * - 无冲突的普通 AI 修改：静默（不建冲突、不打 toast）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FileChangeRecordView } from '@novai/core/services/types'

import { useChatStore } from '../stores/chat'
import { useToast } from './useToast'
import {
  _resetEditorSessionsForTest,
  getEditorSession,
  openEditorSession,
  setEditorInput,
  setEditorProbeHandler,
} from './editor-session'
import { _clearFileDraftsForTest } from './useFileDrafts'
import { _getHighlightState, clearChangeHighlights } from './useChangeHighlights'
import { useFileChangeFeedback } from './useFileChangeFeedback'

const openFile = vi.hoisted(() => vi.fn())
const probeFile = vi.hoisted(() => vi.fn())

vi.mock('../stores/project', () => ({
  useProjectStore: () => ({
    currentProject: { id: 'p1', name: '项目一', files: [] },
    activeFile: null,
    openFile,
    clearActiveFile: vi.fn(),
    probeFile,
  }),
}))

const A_PATH = 'chapters/001-开局.md'
const B_PATH = 'chapters/002-转折.md'

let changeSeq = 0
/** 构造一条 AI updated 变更账本记录（每次新 recordId，复刻连续修改） */
function aiUpdateRecord(path: string): FileChangeRecordView {
  changeSeq += 1
  return {
    id: `rec-${changeSeq}`,
    runId: 'run-1',
    at: new Date(2026, 10, 20, 12, changeSeq).toISOString(),
    change: { type: 'updated', path },
  }
}

/** watch（pre 队列）与 freeze→probe 的异步链都要落地 */
async function flushAsync() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

describe('useFileChangeFeedback 冲突反馈分层（真实事件链）', () => {
  let chatStore: ReturnType<typeof useChatStore>
  let aiDiskVersion: string
  let panelState: { path: string | null; viewMode: 'preview' | 'edit'; dirty: boolean }

  beforeEach(() => {
    setActivePinia(createPinia())
    openFile.mockReset()
    probeFile.mockReset()
    aiDiskVersion = ''
    probeFile.mockImplementation(async () => ({
      kind: 'ok',
      file: { path: A_PATH, name: '001-开局.md', format: 'text', content: aiDiskVersion, updatedAt: 't9' },
    }))
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorProbeHandler(probeFile)
    clearChangeHighlights('p1')
    useToast().toasts.value.splice(0)

    chatStore = useChatStore()
    chatStore.activeSessionId = 's1'
    chatStore.sessions = [
      { sessionId: 's1', title: '现场会话' },
      { sessionId: 's2', title: '后台会话乙' },
    ] as never
    chatStore.clearRecentFileChanges()

    // 人工正在编辑 A（未落盘内容），面板状态可注入
    openEditorSession('p1', A_PATH, '磁盘基线', 't0')
    setEditorInput('p1', A_PATH, '人工未落盘内容')
    panelState = { path: A_PATH, viewMode: 'edit', dirty: true }

    useFileChangeFeedback({
      projectId: () => 'p1',
      getPanelState: () => panelState,
      openContentPanel: () => {},
      setPanelNotice: () => {},
    })
  })

  /** 按到达顺序逐条入账（与真实 file-changed 事件节奏一致），每条等处理完成 */
  async function deliver(record: FileChangeRecordView, sessionId = 's1') {
    chatStore.recentFileChanges = [
      ...chatStore.recentFileChanges,
      { projectId: 'p1', sessionId, record },
    ]
    await flushAsync()
  }

  it('人工编辑中 AI 连续三次修改同一文件：黄色冲突唯一、冲突 toast 为零、磁盘快照跟随最新', async () => {
    aiDiskVersion = 'AI 第一版'
    await deliver(aiUpdateRecord(A_PATH))
    aiDiskVersion = 'AI 第二版'
    await deliver(aiUpdateRecord(A_PATH))
    aiDiskVersion = 'AI 第三版'
    await deliver(aiUpdateRecord(A_PATH))

    // 黄色冲突条唯一：会话上只有一个 conflict，代次递增到 3，磁盘快照是最后一次 AI 版本
    const session = getEditorSession('p1', A_PATH)!
    expect(session.conflict).toBeDefined()
    expect(session.conflict!.generation).toBe(3)
    expect(session.conflict!.disk?.content).toBe('AI 第三版')
    expect(session.conflict!.expanded).toBe(false)
    // 人工内容未被清掉
    expect(session.content).toBe('人工未落盘内容')

    // 冲突 toast 为零
    const toasts = useToast().toasts.value
    expect(toasts.filter((t) => t.message.includes('已被 AI 修改'))).toHaveLength(0)

    // 底层变更账本不动（三条全在，反馈收起不删数据）
    expect(chatStore.recentFileChanges).toHaveLength(3)
  })

  it('无冲突的普通 AI 修改：静默（不建冲突、不打 toast）', async () => {
    // 用户在编辑 B、B 无未落盘内容（干净）：对 B 的普通修改不抢现场也不给通知
    panelState = { path: B_PATH, viewMode: 'edit', dirty: false }
    await deliver(aiUpdateRecord(B_PATH))

    expect(useToast().toasts.value.filter((t) => t.message.includes('已被 AI 修改'))).toHaveLength(0)
    expect(getEditorSession('p1', B_PATH)?.conflict).toBeUndefined()
  })

  it('clean 编辑态普通修改不建冲突，同一文件随后变 dirty 再被修改即进入冲突', async () => {
    // 第一拍：用户在编辑 A 但内容已落盘（clean）→ 普通修改不建冲突
    panelState = { path: A_PATH, viewMode: 'edit', dirty: false }
    aiDiskVersion = 'AI 第一版'
    await deliver(aiUpdateRecord(A_PATH))
    expect(getEditorSession('p1', A_PATH)?.conflict).toBeUndefined()

    // 第二拍：用户输入未落盘内容 → 同一文件再被 AI 修改 → 进入冲突
    panelState = { path: A_PATH, viewMode: 'edit', dirty: true }
    aiDiskVersion = 'AI 第二版'
    await deliver(aiUpdateRecord(A_PATH))

    // 黄色冲突条接管（唯一反馈），账本仍在
    expect(chatStore.recentFileChanges).toHaveLength(2)
    expect(getEditorSession('p1', A_PATH)?.conflict?.disk?.content).toBe('AI 第二版')
  })

  it('非当前文件首次冲突：仅一次 toast 指路，后续修改静默刷新', async () => {
    // 用户在看 B；A 有未落盘草稿（编辑过又切走）
    panelState = { path: B_PATH, viewMode: 'preview', dirty: false }

    aiDiskVersion = 'AI 第一版'
    await deliver(aiUpdateRecord(A_PATH))
    expect(useToast().toasts.value.filter((t) => t.message.includes('已被 AI 修改'))).toHaveLength(1)
    expect(getEditorSession('p1', A_PATH)?.conflict?.disk?.content).toBe('AI 第一版')

    // 同一冲突内 AI 再改：不新增 toast，磁盘快照跟随最新
    aiDiskVersion = 'AI 第二版'
    await deliver(aiUpdateRecord(A_PATH))
    expect(useToast().toasts.value.filter((t) => t.message.includes('已被 AI 修改'))).toHaveLength(1)
    expect(getEditorSession('p1', A_PATH)?.conflict?.disk?.content).toBe('AI 第二版')
    expect(getEditorSession('p1', A_PATH)?.conflict?.expanded).toBe(false)
  })
})
