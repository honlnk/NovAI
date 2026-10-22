import { describe, expect, it } from 'vitest'

import {
  buildElementCatalogReminder,
  syncElementCatalogReminder,
} from './element-catalog-reminder'
import { createModelView, setSystemMessage, type ModelView } from './model-view'

import type { ChatSessionState } from '../../types/chat'
import type { ElementCatalogEntry } from '../../types/elements'

const ENTRIES: ElementCatalogEntry[] = [
  { type: 'character', name: '林晚', summary: '冷静克制的外科医生，隐藏身份是前特工', sourcePath: 'elements/characters/林晚.md' },
  { type: 'location', name: '临江医院', summary: '故事主舞台，地下三层有秘密实验室', sourcePath: 'elements/locations/临江医院.md' },
]

function makeSession(): ChatSessionState {
  return {
    sessionId: 'session-catalog',
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

describe('buildElementCatalogReminder', () => {
  it('首注文案：<system-reminder> 包裹、类型标签分组行、LoadElements 指引', () => {
    const content = buildElementCatalogReminder(ENTRIES, { isUpdate: false })

    expect(content).toContain('<system-reminder>')
    expect(content).toContain('以下是本书的要素清单（角色/地点/实体/世界观设定），按类型分组。')
    expect(content).toContain('<available_elements>')
    expect(content).toContain('- [角色] 林晚 — 冷静克制的外科医生，隐藏身份是前特工')
    expect(content).toContain('- [地点] 临江医院 — 故事主舞台，地下三层有秘密实验室')
    expect(content).toContain('当你需要使用某个要素的完整定义时，调用 LoadElements 工具并传入其名称。')
    expect(content.trim().endsWith('</system-reminder>')).toBe(true)
  })

  it('更新文案：声明取代此前任何版本', () => {
    const content = buildElementCatalogReminder(ENTRIES, { isUpdate: true })
    expect(content).toContain('以下是最新的本书要素清单')
    expect(content).toContain('取代此前任何版本')
  })
})

describe('syncElementCatalogReminder', () => {
  it('首次注入在 system 之后（index 1），先于全部历史', () => {
    const view = makeView()
    const session = makeSession()

    syncElementCatalogReminder({ view, session, entries: ENTRIES })

    expect(view.messages[1]!.role).toBe('user')
    expect(view.messages[1]!.content).toContain('<available_elements>')
    expect(view.messages[0]!.content).toBe('system prompt')
    expect(view.messages[2]!.content).toBe('历史用户消息')
    expect(session.elementCatalogDigest).toBeTruthy()
  })

  it('digest 不变时不替换（消息对象引用与位置均不动）', () => {
    const view = makeView()
    const session = makeSession()
    syncElementCatalogReminder({ view, session, entries: ENTRIES })

    const reminderBefore = view.messages[1]
    const historyBefore = view.messages[2]
    syncElementCatalogReminder({ view, session, entries: [...ENTRIES] })

    expect(view.messages[1]).toBe(reminderBefore)
    expect(view.messages[2]).toBe(historyBefore)
    expect(view.messages).toHaveLength(4)
  })

  it('digest 变化时原位替换：位置不动、其余消息对象保持', () => {
    const view = makeView()
    const session = makeSession()
    syncElementCatalogReminder({ view, session, entries: ENTRIES })

    const historyMessage = view.messages[2]
    const updatedEntries: ElementCatalogEntry[] = [
      ENTRIES[0]!,
      ENTRIES[1]!,
      { type: 'entity', name: '密信', summary: '推动剧情的关键信物', sourcePath: 'elements/entities/密信.md' },
    ]
    syncElementCatalogReminder({ view, session, entries: updatedEntries })

    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.content).toContain('- [实体] 密信')
    expect(view.messages[1]!.content).toContain('取代此前任何版本')
    expect(view.messages[2]).toBe(historyMessage)
  })

  it('reminder 被压缩吞掉后，下一次 sync 检测缺失并重新插入', () => {
    const view = makeView()
    const session = makeSession()
    syncElementCatalogReminder({ view, session, entries: ENTRIES })

    // 模拟 compaction 吞掉 reminder：从视图中移除（压缩选区从 index 1 起）
    view.messages.splice(1, 1)
    expect(view.messages).toHaveLength(3)

    // digest 未变（要素集没变），但视图里没了 → 仍需重插
    syncElementCatalogReminder({ view, session, entries: [...ENTRIES] })

    expect(view.messages).toHaveLength(4)
    expect(view.messages[1]!.role).toBe('user')
    expect(view.messages[1]!.content).toContain('<available_elements>')
    // 重插走首注文案（视图里没有旧版本可取代）
    expect(view.messages[1]!.content).toContain('以下是本书的要素清单')
  })

  it('空目录不注入（无四类要素的项目保持视图干净）', () => {
    const view = makeView()
    const session = makeSession()

    syncElementCatalogReminder({ view, session, entries: [] })

    expect(view.messages).toHaveLength(3)
    expect(session.elementCatalogDigest).toBeUndefined()
  })
})
