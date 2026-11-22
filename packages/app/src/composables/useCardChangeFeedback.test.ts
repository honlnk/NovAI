// @vitest-environment happy-dom
/**
 * 卡片域变更链（阶段 3）事件链测试：chatStore.recentFileChanges 入账 →
 * useCardChangeFeedback 的 watch 消费 → 注入的三域适配器被正确调度。
 * 适配器是纯注入对象，这里用桩验证组合式本身的调度语义：
 * - dirty 会话的内容变更 → 冻结建立冲突；反馈分层（当前卡零 toast、非当前卡
 *   首次一次 toast、后续静默）；
 * - 删除/重命名 dirty 会话 → 守护（删除带回收站路径、重命名带新路径）；当前
 *   打开的卡顺带展开内容面板；无草稿卡不置守护；
 * - 干净会话 → 当前打开的卡重读详情跟上最新，非当前卡无动作；
 * - 非卡片目录与看板未收录的新路径不触达任何会话动作。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FileChangeRecordView } from '@novai/core/services/types'

import { useChatStore } from '../stores/chat'
import { useToast } from './useToast'
import { useCardChangeFeedback, type CardChangeDomainAdapter } from './useCardChangeFeedback'

const PLAN_PATH = 'plans/plan-1-a.md'
const CHAPTER_PATH = 'chapters/001-开局.md'

let changeSeq = 0
/** 构造一条 AI 变更账本记录（每次新 recordId，复刻连续修改） */
function record(change: FileChangeRecordView['change']): FileChangeRecordView {
  changeSeq += 1
  return {
    id: `rec-${changeSeq}`,
    runId: 'run-1',
    at: new Date(2026, 10, 20, 12, changeSeq).toISOString(),
    change,
  }
}

async function flushAsync() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

function makeAdapter(prefix: string) {
  const adapter = {
    pathPrefix: prefix,
    getCards: vi.fn(() => [{ id: 'a', sourcePath: PLAN_PATH, name: '计划甲' }]),
    freeze: vi.fn(async (): Promise<'conflict' | 'conflict-refresh' | 'clean' | 'none'> => 'none'),
    hasDraft: vi.fn(() => false),
    setGuard: vi.fn(),
    reopen: vi.fn(async () => {}),
  }
  return adapter as CardChangeDomainAdapter & typeof adapter
}

describe('useCardChangeFeedback 卡片域变更链', () => {
  let chatStore: ReturnType<typeof useChatStore>
  let plans: ReturnType<typeof makeAdapter>
  let openPanelCalls: number
  let isOpen: (domain: 'plans' | 'foreshadowing' | 'rhythm', cardId: string) => boolean

  beforeEach(() => {
    setActivePinia(createPinia())
    useToast().toasts.value.splice(0)

    chatStore = useChatStore()
    chatStore.activeSessionId = 's1'
    chatStore.clearRecentFileChanges()

    plans = makeAdapter('plans/')
    openPanelCalls = 0
    isOpen = () => false

    useCardChangeFeedback({
      projectId: () => 'p1',
      isCardOpen: (domain, cardId) => isOpen(domain, cardId),
      openContentPanel: () => {
        openPanelCalls += 1
      },
      domains: {
        plans,
        foreshadowing: makeAdapter('foreshadowing/'),
        rhythm: makeAdapter('rhythm/'),
      },
    })
  })

  async function deliver(change: FileChangeRecordView['change']) {
    chatStore.recentFileChanges = [
      ...chatStore.recentFileChanges,
      { projectId: 'p1', sessionId: 's1', record: record(change) },
    ]
    await flushAsync()
  }

  it('非卡片目录的变更不触达任何会话动作', async () => {
    await deliver({ type: 'updated', path: CHAPTER_PATH })
    expect(plans.freeze).not.toHaveBeenCalled()
    expect(plans.setGuard).not.toHaveBeenCalled()
  })

  it('看板未收录的新路径（AI 新建卡片）不触达会话动作', async () => {
    await deliver({ type: 'created', path: 'plans/plan-2-new.md' })
    expect(plans.freeze).not.toHaveBeenCalled()
  })

  it('dirty 会话的内容变更：冻结建立冲突；当前卡零 toast（黄条唯一），非当前卡首次一次 toast', async () => {
    plans.freeze.mockResolvedValue('conflict')
    await deliver({ type: 'updated', path: PLAN_PATH })
    expect(plans.freeze).toHaveBeenCalledWith('p1', 'a')
    // 非当前卡：首次冲突一次 toast 指路
    expect(useToast().toasts.value.filter((t) => t.message.includes('计划甲'))).toHaveLength(1)

    // 同一冲突内 AI 再改：静默刷新（不新增 toast）
    plans.freeze.mockResolvedValue('conflict-refresh')
    await deliver({ type: 'updated', path: PLAN_PATH })
    expect(useToast().toasts.value.filter((t) => t.message.includes('计划甲'))).toHaveLength(1)

    // 当前打开的卡进入冲突：黄条在当前现场即唯一反馈，不 toast
    plans.freeze.mockClear()
    plans.freeze.mockResolvedValue('conflict')
    isOpen = () => true
    useToast().toasts.value.splice(0)
    await deliver({ type: 'updated', path: PLAN_PATH })
    expect(plans.freeze).toHaveBeenCalledWith('p1', 'a')
    expect(useToast().toasts.value).toHaveLength(0)
  })

  it('干净会话（clean）：当前打开的卡重读详情，非当前卡无动作', async () => {
    plans.freeze.mockResolvedValue('clean')
    isOpen = () => true
    await deliver({ type: 'updated', path: PLAN_PATH })
    expect(plans.reopen).toHaveBeenCalledWith('p1', 'a')

    plans.reopen.mockClear()
    isOpen = () => false
    await deliver({ type: 'updated', path: PLAN_PATH })
    expect(plans.reopen).not.toHaveBeenCalled()
  })

  it('AI 删除 dirty 卡：置删除守护（带回收站路径），当前卡顺带展开面板', async () => {
    plans.hasDraft.mockReturnValue(true)
    isOpen = () => true
    await deliver({ type: 'deleted', path: PLAN_PATH, trashPath: '.trash/plans/plan-1-a.md' })

    expect(plans.setGuard).toHaveBeenCalledWith('p1', 'a', {
      kind: 'deleted',
      trashPath: '.trash/plans/plan-1-a.md',
    })
    expect(openPanelCalls).toBe(1)
    expect(useToast().toasts.value.some((t) => t.message.includes('已被删除'))).toBe(true)
  })

  it('AI 重命名 dirty 卡：置重命名守护（带新路径）；无草稿卡不置守护', async () => {
    plans.hasDraft.mockReturnValue(true)
    await deliver({ type: 'renamed', fromPath: PLAN_PATH, toPath: 'plans/plan-1-b.md' })
    expect(plans.setGuard).toHaveBeenCalledWith('p1', 'a', {
      kind: 'renamed',
      toPath: 'plans/plan-1-b.md',
    })

    plans.hasDraft.mockReturnValue(false)
    plans.setGuard.mockClear()
    await deliver({ type: 'deleted', path: PLAN_PATH, trashPath: '.trash/plans/plan-1-a.md' })
    expect(plans.setGuard).not.toHaveBeenCalled()
  })
})
