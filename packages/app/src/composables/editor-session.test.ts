import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashContent } from '@novai/core'
import {
  _setDraftBackupStoreForTest,
  buildDraftKey,
  type DraftBackupStore,
  type PersistedDraftRecord,
} from './draft-backup'
import {
  EDITOR_AUTOSAVE_DEBOUNCE_MS,
  _resetEditorSessionsForTest,
  clearEditorSession,
  editorSessionPhase,
  getEditorSession,
  openEditorSession,
  requestEditorSave,
  setEditorInput,
  setEditorProbeHandler,
  setEditorSaveHandler,
  type EditorSaveHandler,
} from './editor-session'
import { _clearFileDraftsForTest, getFileDraft } from './useFileDrafts'

/**
 * 编辑会话状态机事件序（正文自动保存与并发冲突交互重设计计划 阶段 1 验收）：
 * 受控 Promise + 可控时钟覆盖旧写晚到、等待期间新输入、同路径跨项目、保存回写
 * 对象与失败恢复；每次写盘断言磁盘调用与恢复镜像（IndexedDB 备份）两侧。
 */

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

type SaveCall = { path: string; content: string; options?: Record<string, unknown> }

function createDeferredSaveHandler() {
  const calls: SaveCall[] = []
  const pending: Array<(value: import('../stores/project').SaveFileOutcome) => void> = []
  const handler: EditorSaveHandler = vi.fn((path, content, options) => {
    calls.push({ path, content, options })
    return new Promise<import('../stores/project').SaveFileOutcome>((resolve) => {
      pending.push(resolve)
    })
  })
  /** 放行第 n 次（1 起）在途写盘 */
  const release = (index: number, value: import('../stores/project').SaveFileOutcome) => {
    pending[index - 1]!(value)
  }
  return { handler, calls, release }
}

const A_PATH = 'chapters/a.txt'

function fileView(content: string, updatedAt: string) {
  return { path: A_PATH, name: 'a.txt', format: 'text' as const, content, updatedAt }
}

describe('editor-session 保存编排事件序', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(() => {
    vi.useFakeTimers()
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    setEditorProbeHandler(null)
    store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('保存快照带基线版本与基线内容哈希（core 校验所需的完整身份）', async () => {
    const { handler, calls, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const saving = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[0]).toEqual({
      path: A_PATH,
      content: 'v1',
      options: { projectId: 'p1', expectedUpdatedAt: 't0', expectedBaseHash: hashContent('v0') },
    })
    release(1, { ok: true, file: fileView('v1', 't1') })
    await saving
  })

  it('写盘在途继续输入：先落旧快照，新输入保留并按新基线进恢复镜像', async () => {
    const { handler, calls, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const saving = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)

    // 写盘在途继续输入：不清除、不回滚
    setEditorInput('p1', A_PATH, 'v2')
    expect(session.content).toBe('v2')
    expect(session.inFlight?.content).toBe('v1')

    release(1, { ok: true, file: fileView('v1', 't1') })
    await saving
    await vi.advanceTimersByTimeAsync(800)

    // 只承认旧快照已落盘：新输入保留为待写，基线 rebase 到 v1，镜像同步新基线
    expect(session.content).toBe('v2')
    expect(session.baseContent).toBe('v1')
    expect(session.baseUpdatedAt).toBe('t1')
    expect(editorSessionPhase(session)).toBe('pending')
    const record = store.records.get(buildDraftKey('p1', A_PATH))
    expect(record?.content).toBe('v2')
    expect(record?.baseContent).toBe('v1')
    expect(calls).toHaveLength(1)
  })

  it('同键串行：在途期间的新保存请求等前一个完成后以最新输入执行', async () => {
    const { handler, calls, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const first = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    setEditorInput('p1', A_PATH, 'v2')
    const second = requestEditorSave('p1', A_PATH, { trigger: 'manual' })

    release(1, { ok: true, file: fileView('v1', 't1') })
    await first
    await vi.advanceTimersByTimeAsync(0)
    // 第二个请求已按最新输入 v2 启动
    expect(calls[1]?.content).toBe('v2')
    release(2, { ok: true, file: fileView('v2', 't2') })
    await second
    await vi.advanceTimersByTimeAsync(800)

    expect(session.content).toBe('v2')
    expect(session.baseContent).toBe('v2')
    expect(editorSessionPhase(session)).toBe('clean')
    // 全部落盘：恢复镜像清除（刷新后不复活已写完内容）
    expect(store.records.has(buildDraftKey('p1', A_PATH))).toBe(false)
  })

  it('旧写晚到：结果只作用于固定归属的会话，同路径另一项目不受影响', async () => {
    const { handler, calls, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const sessionP1 = openEditorSession('p1', A_PATH, '甲原文', 't0')
    setEditorInput('p1', A_PATH, '甲草稿')
    const sessionP2 = openEditorSession('p2', A_PATH, '乙原文', 's0')
    setEditorInput('p2', A_PATH, '乙草稿')

    const savingP1 = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    // 甲写盘在途时切到乙（乙也保存）
    const savingP2 = requestEditorSave('p2', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)

    release(1, { ok: true, file: fileView('甲草稿', 't1') })
    release(2, { ok: true, file: fileView('乙草稿', 's1') })
    await Promise.all([savingP1, savingP2])
    await vi.advanceTimersByTimeAsync(800)

    expect(calls[0]?.options).toMatchObject({ projectId: 'p1' })
    expect(calls[1]?.options).toMatchObject({ projectId: 'p2' })
    expect(sessionP1.content).toBe('甲草稿')
    expect(sessionP1.baseContent).toBe('甲草稿')
    expect(sessionP2.content).toBe('乙草稿')
    expect(sessionP2.baseContent).toBe('乙草稿')
    // 两侧恢复镜像按各自项目与基线落盘
    expect(store.records.get(buildDraftKey('p1', A_PATH))).toBeUndefined()
    expect(store.records.get(buildDraftKey('p2', A_PATH))).toBeUndefined()
  })

  it('保存成功回写对象（同路径新版本）：会话重定基线，不产生任何重置副作用', async () => {
    const { handler, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const saving = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    // store.saveFile 成功后以「同路径新对象」回写 activeFile —— 会话只重定基线
    release(1, { ok: true, file: fileView('v1', 't1') })
    await saving
    await vi.advanceTimersByTimeAsync(800)

    expect(session.content).toBe('v1')
    expect(session.baseContent).toBe('v1')
    expect(session.baseUpdatedAt).toBe('t1')
    expect(session.inFlight).toBeNull()
    expect(session.failure).toBeUndefined()
    expect(session.conflict).toBeUndefined()
    expect(editorSessionPhase(session)).toBe('clean')
    expect(store.records.has(buildDraftKey('p1', A_PATH))).toBe(false)
  })

  it('普通写入失败：内容与位置保留、失败态持续；手动重试成功后清失败', async () => {
    const { handler, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const failing = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    release(1, { ok: false, conflict: false, message: '写入失败：权限不足' })
    await failing

    expect(session.content).toBe('v1')
    expect(session.failure?.message).toBe('写入失败：权限不足')
    expect(editorSessionPhase(session)).toBe('failed')
    // 失败不自动重试（阶段 1 手动模式；阶段 2 起补一次自动重试）
    await vi.advanceTimersByTimeAsync(5000)
    expect(handler).toHaveBeenCalledTimes(1)
    // 镜像保留未落盘内容
    await vi.advanceTimersByTimeAsync(800)
    expect(store.records.get(buildDraftKey('p1', A_PATH))?.content).toBe('v1')

    // 手动重试成功：失败清除、基线上移
    const retry = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    release(2, { ok: true, file: fileView('v1', 't2') })
    await retry
    expect(session.failure).toBeUndefined()
    expect(editorSessionPhase(session)).toBe('clean')
  })

  it('保存冲突：读取外部版本登记冲突；冲突期间自动触发不写、手动触发仍可尝试', async () => {
    const { handler, calls, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    setEditorProbeHandler(async () => ({ kind: 'ok', file: fileView('AI 版本', 't9') }))
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')

    const conflicting = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    release(1, { ok: false, conflict: true, message: '已被外部修改' })
    await conflicting
    await vi.advanceTimersByTimeAsync(0)

    // 冲突登记：输入保留、外部版本可读、自动写入冻结
    expect(session.content).toBe('v1')
    expect(session.conflict?.disk?.content).toBe('AI 版本')
    expect(session.conflict?.expanded).toBe(true)
    expect(editorSessionPhase(session)).toBe('conflict')

    // 自动触发（去抖收口）在冲突下拒绝写盘
    await requestEditorSave('p1', A_PATH, { trigger: 'flush' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledTimes(1)

    // 手动触发是用户明确选择：允许再次尝试（会再撞版本校验）
    const retry = requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledTimes(2)
    release(2, { ok: false, conflict: true, message: '已被外部修改' })
    await retry
    expect(calls[1]?.options).toMatchObject({ projectId: 'p1' })
  })

  it('守护未决时禁止一切写入（含手动）；输入与守护状态保留', async () => {
    const { handler } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    session.guard = { kind: 'deleted', trashPath: '.novel/trash/a.txt' }

    await requestEditorSave('p1', A_PATH, { trigger: 'manual' })
    await requestEditorSave('p1', A_PATH, { trigger: 'flush' })
    expect(handler).not.toHaveBeenCalled()
    expect(session.content).toBe('v1')
    expect(editorSessionPhase(session)).toBe('guard')
    expect(getFileDraft('p1', A_PATH)).toBe('v1')
  })

  it('输入去抖（阶段 2 能力预演）：打开后按 2000ms 窗口自动收口一次', async () => {
    const { setAutosaveInputEnabled } = await import('./editor-session')
    const { handler, release } = createDeferredSaveHandler()
    setEditorSaveHandler(handler)
    setAutosaveInputEnabled(true)
    try {
      const session = openEditorSession('p1', A_PATH, 'v0', 't0')
      setEditorInput('p1', A_PATH, 'v1')
      setEditorInput('p1', A_PATH, 'v2')
      // 未到窗口：不写盘
      await vi.advanceTimersByTimeAsync(EDITOR_AUTOSAVE_DEBOUNCE_MS - 1)
      expect(handler).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenLastCalledWith(A_PATH, 'v2', expect.objectContaining({ projectId: 'p1' }))
      release(1, { ok: true, file: fileView('v2', 't1') })
      await vi.advanceTimersByTimeAsync(0)
      expect(editorSessionPhase(session)).toBe('clean')
    } finally {
      setAutosaveInputEnabled(false)
    }
  })
})

describe('editor-session 会话生命周期', () => {
  beforeEach(() => {
    _clearFileDraftsForTest()
    _resetEditorSessionsForTest()
    setEditorSaveHandler(null)
    _setDraftBackupStoreForTest(createMemoryStore())
  })

  it('openEditorSession 复用已有会话：草稿不因重新进入编辑而丢失', () => {
    const first = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    const second = openEditorSession('p1', A_PATH, 'v0', 't0')
    expect(second).toBe(first)
    expect(second.content).toBe('v1')
  })

  it('clearEditorSession 清会话并删除恢复镜像', async () => {
    const store = createMemoryStore()
    _setDraftBackupStoreForTest(store)
    const session = openEditorSession('p1', A_PATH, 'v0', 't0')
    setEditorInput('p1', A_PATH, 'v1')
    clearEditorSession('p1', A_PATH)
    expect(getEditorSession('p1', A_PATH)).toBeUndefined()
    await vi.waitFor(() => expect(store.records.has(buildDraftKey('p1', A_PATH))).toBe(false))
  })
})
