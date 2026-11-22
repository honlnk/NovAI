import { describe, expect, it } from 'vitest'

import {
  digestCatalogEntries,
  syncCatalogReminder,
  type CatalogChannel,
} from './catalog-reminder'
import {
  createModelView,
  insertAfterLeadingReminders,
  setSystemMessage,
  type ModelView,
} from '../agent/model-view'

import type { ChatSessionState } from '../../types/chat'

/** 测试用通道 A：模拟要素目录（placement 缺省 after-system）。 */
interface TestEntry {
  name: string
  summary: string
}

function makeChannelA(): CatalogChannel<TestEntry> {
  return {
    marker: '<channel_a>',
    render(entries, { isUpdate }) {
      const head = isUpdate ? '最新 A 清单' : 'A 清单'
      return [
        '<system-reminder>',
        head,
        '<channel_a>',
        ...entries.map((entry) => `- ${entry.name} — ${entry.summary}`),
        '</channel_a>',
        '</system-reminder>',
      ].join('\n')
    },
    digestOf(entries) {
      return [...entries].map((entry) => `${entry.name}:${entry.summary}`).join('|')
    },
    readDigest(session) {
      return session.digestA
    },
    writeDigest(session, digest) {
      session.digestA = digest
    },
  }
}

/** 测试用通道 B：模拟技能目录（placement: after-leading-reminders）。 */
function makeChannelB(): CatalogChannel<TestEntry> {
  return {
    ...makeChannelA(),
    marker: '<channel_b>',
    render(entries, { isUpdate }) {
      const head = isUpdate ? '最新 B 清单' : 'B 清单'
      return [
        '<system-reminder>',
        head,
        '<channel_b>',
        ...entries.map((entry) => `- ${entry.name}（${entry.summary}）`),
        '</channel_b>',
        '</system-reminder>',
      ].join('\n')
    },
    writeDigest(session, digest) {
      session.digestB = digest
    },
  }
}

// 会话测试桩：补两个临时 digest 字段（真实字段按通道各自声明，见 types/chat.ts）
type TestSession = ChatSessionState & { digestA?: string; digestB?: string }

function makeSession(): TestSession {
  return {
    sessionId: 'session-disclosure',
    projectId: 'proj',
    messages: [],
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    title: '测试会话',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeView(): ModelView {
  const view = createModelView()
  setSystemMessage(view, 'system prompt')
  view.messages.push({ role: 'user', content: '历史用户消息' })
  view.messages.push({ role: 'assistant', content: '历史回复' })
  return view
}

const ENTRIES: TestEntry[] = [
  { name: '林晚', summary: '外科医生' },
  { name: '临江医院', summary: '主舞台' },
]

describe('syncCatalogReminder', () => {
  it('空目录不注入', () => {
    const view = makeView()
    const session = makeSession()

    syncCatalogReminder({ view, session, entries: [], channel: makeChannelA() })

    expect(view.messages).toHaveLength(3)
    expect(session.digestA).toBeUndefined()
  })

  it('首注：插在 system 之后（index 1），digest 写入会话', () => {
    const view = makeView()
    const session = makeSession()

    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })

    expect(view.messages[1]!.role).toBe('user')
    expect(view.messages[1]!.content).toContain('<channel_a>')
    expect(view.messages[1]!.content).toContain('A 清单')
    expect(session.digestA).toBeTruthy()
  })

  it('digest 未变时跳过（消息对象引用与位置均不动）', () => {
    const view = makeView()
    const session = makeSession()
    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })

    const reminderBefore = view.messages[1]
    syncCatalogReminder({ view, session, entries: [...ENTRIES], channel: makeChannelA() })

    expect(view.messages[1]).toBe(reminderBefore)
    expect(view.messages).toHaveLength(4)
  })

  it('digest 变化时原位替换，其余消息对象保持', () => {
    const view = makeView()
    const session = makeSession()
    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })

    const historyMessage = view.messages[2]
    syncCatalogReminder({
      view,
      session,
      entries: [...ENTRIES, { name: '密信', summary: '信物' }],
      channel: makeChannelA(),
    })

    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('最新 A 清单')
    expect(view.messages[2]).toBe(historyMessage)
  })

  it('reminder 被压缩吞掉后自动重插（digest 未变也重注）', () => {
    const view = makeView()
    const session = makeSession()
    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })

    view.messages.splice(1, 1)
    expect(view.messages).toHaveLength(3)

    syncCatalogReminder({ view, session, entries: [...ENTRIES], channel: makeChannelA() })

    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('<channel_a>')
    // 重插走首注文案（视图里没有旧版本可取代）
    expect(view.messages[1]!.content).toContain('A 清单')
    expect(view.messages[1]!.content).not.toContain('最新 A 清单')
  })

  it('两条通道并存互不干扰：各自 marker 定位、各自会话字段', () => {
    const view = makeView()
    const session = makeSession()

    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })
    syncCatalogReminder({ view, session, entries: [{ name: '去AI味', summary: '写作方法' }], channel: makeChannelB() })

    // after-system 通道恒插 index 1（后注入者在前）；after-leading-reminders 通道插到连续 reminder 块末尾
    expect(view.messages[1]!.content).toContain('<channel_b>')
    expect(view.messages[2]!.content).toContain('<channel_a>')
    expect(session.digestA).toBeTruthy()
    expect(session.digestB).toBeTruthy()

    // 通道 A 变化只替换 A 的 reminder，B 不动
    const bReminder = view.messages[1]
    syncCatalogReminder({
      view,
      session,
      entries: [...ENTRIES, { name: '密信', summary: '信物' }],
      channel: makeChannelA(),
    })
    expect(view.messages[1]).toBe(bReminder)
    expect(view.messages[2]!.content).toContain('最新 A 清单')
  })

  it('目录清空（缺省通道）：既有 reminder 原样保留（要素通道行为锁定）', () => {
    const view = makeView()
    const session = makeSession()
    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })
    const digestBefore = session.digestA

    syncCatalogReminder({ view, session, entries: [], channel: makeChannelA() })

    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('<channel_a>')
    expect(session.digestA).toBe(digestBefore)
  })

  it('目录清空（removeOnEmpty 通道）：移除既有 reminder 并清 digest', () => {
    const view = makeView()
    const session = makeSession()
    const removable = { ...makeChannelB(), removeOnEmpty: true }
    syncCatalogReminder({ view, session, entries: [{ name: '去AI味', summary: '写作方法' }], channel: removable })
    syncCatalogReminder({ view, session, entries: ENTRIES, channel: makeChannelA() })
    expect(view.messages).toHaveLength(5)

    syncCatalogReminder({ view, session, entries: [], channel: removable })

    // B 的 reminder 被移除，A 的不受影响，历史消息对象保持
    expect(view.messages).toHaveLength(4)
    expect(view.messages.map((message) => message.content).join('\n')).not.toContain('<channel_b>')
    expect(view.messages[1]!.content).toContain('<channel_a>')
    expect(session.digestB).toBeUndefined()
    expect(session.digestA).toBeTruthy()
  })
})

describe('digestCatalogEntries', () => {
  it('枚举顺序归一：不同顺序的同一批条目 digest 相同', () => {
    const a: TestEntry[] = [
      { name: '甲', summary: '一' },
      { name: '乙', summary: '二' },
    ]
    const b: TestEntry[] = [
      { name: '乙', summary: '二' },
      { name: '甲', summary: '一' },
    ]
    const digestOf = (entries: readonly TestEntry[]) => digestCatalogEntries(entries, {
      compare: (x, y) => x.name.localeCompare(y.name),
      project: (entry) => JSON.stringify([entry.name, entry.summary]),
    })

    expect(digestOf(a)).toBe(digestOf(b))
  })

  it('条目内容变化 digest 变化', () => {
    const digestOf = (entries: readonly TestEntry[]) => digestCatalogEntries(entries, {
      compare: (x, y) => x.name.localeCompare(y.name),
      project: (entry) => JSON.stringify([entry.name, entry.summary]),
    })

    expect(digestOf([{ name: '甲', summary: '一' }])).not.toBe(digestOf([{ name: '甲', summary: '改' }]))
  })
})

describe('insertAfterLeadingReminders', () => {
  it('插到 system 之后连续 reminder 块的末尾，先于普通历史', () => {
    const view = createModelView()
    setSystemMessage(view, 'system prompt')
    view.messages.push({ role: 'user', content: '<system-reminder>\n项目记忆\n</system-reminder>' })
    view.messages.push({ role: 'user', content: '<system-reminder>\n约束文档\n</system-reminder>' })
    view.messages.push({ role: 'user', content: '历史用户消息' })

    insertAfterLeadingReminders(view, { role: 'user', content: '新 reminder' })

    expect(view.messages[3]!.content).toBe('新 reminder')
    expect(view.messages[4]!.content).toBe('历史用户消息')
  })

  it('没有已存在 reminder 时插在 system 之后（等同 insertAfterSystem）', () => {
    const view = createModelView()
    setSystemMessage(view, 'system prompt')
    view.messages.push({ role: 'user', content: '历史用户消息' })

    insertAfterLeadingReminders(view, { role: 'user', content: '新 reminder' })

    expect(view.messages[1]!.content).toBe('新 reminder')
    expect(view.messages[2]!.content).toBe('历史用户消息')
  })

  it('普通 user 消息（非 reminder）之后不插入：连续块在第一个非 reminder 处断开', () => {
    const view = createModelView()
    setSystemMessage(view, 'system prompt')
    view.messages.push({ role: 'user', content: '<system-reminder>\n项目记忆\n</system-reminder>' })
    view.messages.push({ role: 'user', content: '历史用户消息' })
    view.messages.push({ role: 'user', content: '<system-reminder>\n后段另一个 reminder\n</system-reminder>' })

    insertAfterLeadingReminders(view, { role: 'user', content: '新 reminder' })

    expect(view.messages[2]!.content).toBe('新 reminder')
    expect(view.messages[3]!.content).toBe('历史用户消息')
    expect(view.messages).toHaveLength(5)
  })

  it('空视图直接作为首条插入', () => {
    const view = createModelView()

    insertAfterLeadingReminders(view, { role: 'user', content: '新 reminder' })

    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]!.content).toBe('新 reminder')
  })
})
