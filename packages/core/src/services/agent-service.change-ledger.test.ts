import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  enqueueMessage,
  subscribeAgentEvents,
  _clearSessionCacheForTest,
} from './agent-service'
import { setRuntimeProject, clearRuntimeProjects } from './project-runtime'
import { query } from '../core/agent/query'
import type { AgentQueryEvent } from '../core/agent/query'
import type { ProjectConfig, ProjectSnapshot } from '../types/project'
import type { AgentUiEvent, ChatMessageView, RunAgentTurnResult } from './types'

/**
 * 改动账本（changeLedger）service 层测试：
 * - collectChangedFiles 改读账本（Bug 1：压缩后清单不再丢准）
 * - change-summary 消息 view 按 runId 从账本解析并按文件聚合（files：净状态 + 行数合计 + records 片段 diff）
 * - ChatSessionView.changedFileCount 会话级去重数
 * - 一轮改多个文件全量列出（Bug 2：不再只报一个）
 *
 * query 打桩到事件层（不发 LLM）；文件系统用内存 handle（会话落盘/提示词读取走它）。
 */

vi.mock('../core/agent/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/agent/query')>()
  return {
    ...actual,
    query: vi.fn(),
  }
})

let logIdCounter = 0
vi.mock('../core/logging/agent-log', () => ({
  createLogId: (prefix: string) => `${prefix}-test-${logIdCounter++}`,
  writeAgentLog: vi.fn(),
}))

const mockedQuery = vi.mocked(query)

const stubConfig = {
  project: { name: 'Test', createdAt: '', updatedAt: '' },
  llm: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
  settings: {
    enableDebugLogging: false,
    conversationTokenLimit: 120000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
  },
} as unknown as ProjectConfig

function emitToolResult(
  emit: (event: AgentQueryEvent) => void,
  input: { id: string; name: 'EditFile' | 'CreateFile' | 'RenameFile' | 'DeleteFile'; path: string; toPath?: string; linesRemoved?: number; diff?: { oldText: string; newText: string; linesAdded: number; linesRemoved: number } },
) {
  const call = { id: input.id, name: input.name, input: {} }
  emit({ type: 'tool-call', call, inputSummary: `调用 ${input.name}` })
  const fileChange = input.name === 'RenameFile'
    ? { type: 'renamed' as const, fromPath: input.path, toPath: input.toPath ?? input.path }
    : input.name === 'DeleteFile'
      ? { type: 'deleted' as const, path: input.path, trashPath: `.novel/trash/${input.path}`, ...(input.linesRemoved !== undefined ? { linesRemoved: input.linesRemoved } : {}) }
      : { type: input.name === 'CreateFile' ? ('created' as const) : ('updated' as const), path: input.path }
  emit({
    type: 'tool-result',
    call,
    ok: true,
    resultSummary: `已处理 ${input.path}`,
    fileChange,
    diff: input.diff,
  })
}

/**
 * 发送一条消息并等待本次连续运行收敛（driver fire-and-forget，经事件总线收 run-finish）。
 * 返回收尾 result 与全程事件流。
 */
async function runOneTurn(instruction: string) {
  const events: AgentUiEvent[] = []
  const finished = new Promise<RunAgentTurnResult>((resolve, reject) => {
    const unsubscribe = subscribeAgentEvents((event) => {
      events.push(event)
      if (event.type === 'run-finish') {
        unsubscribe()
        resolve(event.result)
      }
      if (event.type === 'run-error') {
        unsubscribe()
        reject(new Error(event.error.message))
      }
    })
  })
  await enqueueMessage({ projectId: 'proj-ledger', text: instruction, mode: 'queue' })
  const result = await finished
  return { result, events }
}

function findChangeSummaries(messages: ChatMessageView[]) {
  return messages.filter((message) => message.kind === 'change-summary')
}

describe('改动账本 service 层', () => {
  beforeEach(async () => {
    _clearSessionCacheForTest()
    clearRuntimeProjects()
    mockedQuery.mockReset()
    setRuntimeProject(buildProject())
    await createSession('proj-ledger')
  })

  it('一轮改多个文件：changedFiles 全量列出（Bug 2 消解），change-summary 解析出含 diff 的记录', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, {
        id: 'c1',
        name: 'CreateFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: '', newText: '第一章内容', linesAdded: 1, linesRemoved: 0 },
      })
      emitToolResult(emit, {
        id: 'c2',
        name: 'EditFile',
        path: 'chapters/第002章-重逢.txt',
        diff: { oldText: '旧句', newText: '新句', linesAdded: 1, linesRemoved: 1 },
      })
      emitToolResult(emit, { id: 'c3', name: 'EditFile', path: 'elements/characters/主角.md' })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result, events } = await runOneTurn('写第一章并完善设定')

    // Bug 2：三个文件全在，不再只报最后一个
    expect(result.session.changedFiles).toHaveLength(3)
    const changedPaths = result.session.changedFiles.map((f) => ('path' in f ? f.path : ''))
    expect(changedPaths).toContain('chapters/第001章-初遇.txt')
    expect(changedPaths).toContain('elements/characters/主角.md')

    // change-summary：面板数据按 runId 从账本解析并按文件聚合，片段 diff 收进 records
    const summaries = findChangeSummaries(result.session.messages)
    expect(summaries.length).toBe(1)
    const summary = summaries[0]
    if (summary.kind !== 'change-summary') throw new Error('unreachable')
    expect(summary.aborted).toBeUndefined()
    expect(summary.files).toHaveLength(3)
    expect(summary.files[0]).toMatchObject({
      path: 'chapters/第001章-初遇.txt',
      status: 'created',
      linesAdded: 1,
      linesRemoved: 0,
    })
    expect(summary.files[0].records[0]).toMatchObject({
      change: { type: 'created', path: 'chapters/第001章-初遇.txt' },
      diff: { oldText: '', newText: '第一章内容', linesAdded: 1, linesRemoved: 0 },
    })
    expect(summary.files[2]).toMatchObject({
      path: 'elements/characters/主角.md',
      status: 'updated',
      linesAdded: 0,
      linesRemoved: 0,
    })
    expect(summary.files[2].records[0]?.diff).toBeUndefined()

    // 实时事件流里的 change-summary 同样带聚合好的 files
    const liveSummary = events
      .filter((event) => event.type === 'message')
      .map((event) => event.message)
      .find((message) => message.kind === 'change-summary')
    expect(liveSummary).toBeDefined()
    if (liveSummary?.kind === 'change-summary') {
      expect(liveSummary.files).toHaveLength(3)
    }

    // 会话级去重数
    expect(result.session.changedFileCount).toBe(3)

    // 不再产生文字版完成总结（action-summary）
    expect(result.session.messages.some((m) => m.kind === 'action-summary')).toBe(false)
  })

  it('压缩免疫（Bug 1 回归）：modelView 被压缩替换后 changedFiles 仍准确', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, { id: 'c1', name: 'EditFile', path: 'chapters/第001章-初遇.txt' })
      emitToolResult(emit, { id: 'c2', name: 'EditFile', path: 'chapters/第002章-重逢.txt' })
      // 模拟压缩：tool 消息被摘要替换，modelView 里不再有 fileChange 载体
      input.view.messages = [
        input.view.messages[0],
        { role: 'user', content: '<compacted-summary>早期对话摘要</compacted-summary>' },
      ]
      input.onEvent?.({
        type: 'context-compacted',
        compactedMessageCount: 6,
        originalTokens: 9000,
        summaryTokens: 400,
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('改两章')

    // 旧实现翻 modelView 会在压缩后丢光；账本与 modelView 无关 → 压缩后仍准确
    expect(result.session.changedFiles).toHaveLength(2)
    expect(result.session.changedFileCount).toBe(2)
    const summaries = findChangeSummaries(result.session.messages)
    expect(summaries.length).toBe(1)
    if (summaries[0].kind === 'change-summary') {
      expect(summaries[0].files).toHaveLength(2)
    }
  })

  it('同一文件改两次：聚合为一个文件行，行数为两笔之和，两笔记录按序保留在 records', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, {
        id: 'c1',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'a', newText: 'b', linesAdded: 1, linesRemoved: 1 },
      })
      emitToolResult(emit, {
        id: 'c2',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'b', newText: 'c\nd', linesAdded: 2, linesRemoved: 1 },
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('反复打磨第一章')

    expect(result.session.changedFileCount).toBe(1)
    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    // 文件级聚合：同文件两次操作折叠为一行，行数为各片段之和
    expect(summaries[0].files).toHaveLength(1)
    expect(summaries[0].files[0]).toMatchObject({
      path: 'chapters/第001章-初遇.txt',
      status: 'updated',
      linesAdded: 3,
      linesRemoved: 2,
    })
    expect(summaries[0].files[0]?.records).toHaveLength(2)
    expect(summaries[0].files[0]?.records[0]?.diff?.oldText).toBe('a')
    expect(summaries[0].files[0]?.records[1]?.diff?.oldText).toBe('b')
  })

  it('历史账本里的旧净差口径数字：聚合行数按片段实时重算（+0−0 自愈为 +1−1）', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      // 旧口径账本：一行换一行存的是净差 +0 −0
      emitToolResult(emit, {
        id: 'c1',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'a', newText: 'b', linesAdded: 0, linesRemoved: 0 },
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('改一句')

    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    expect(summaries[0].files[0]).toMatchObject({ linesAdded: 1, linesRemoved: 1 })
  })

  it('改名前后的内容修改归并到同一文件行（净状态 renamed，归到 toPath）', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, {
        id: 'c1',
        name: 'EditFile',
        path: 'chapters/第1章-初遇.txt',
        diff: { oldText: 'a', newText: 'b', linesAdded: 1, linesRemoved: 1 },
      })
      emitToolResult(emit, { id: 'c2', name: 'RenameFile', path: 'chapters/第1章-初遇.txt', toPath: 'chapters/第001章-初遇.txt' })
      emitToolResult(emit, {
        id: 'c3',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'b', newText: 'c', linesAdded: 1, linesRemoved: 1 },
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('润色并规范章节名')

    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    expect(summaries[0].files).toHaveLength(1)
    expect(summaries[0].files[0]).toMatchObject({
      path: 'chapters/第001章-初遇.txt',
      fromPath: 'chapters/第1章-初遇.txt',
      status: 'renamed',
      linesAdded: 2,
      linesRemoved: 2,
    })
    expect(summaries[0].files[0]?.records).toHaveLength(3)
  })

  it('新建后又删除：呈现为一个删除行（不丢弃、不误报「改动记录缺失」），删除行数计入聚合', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, {
        id: 'c1',
        name: 'CreateFile',
        path: 'elements/characters/废案.md',
        diff: { oldText: '', newText: '废案内容', linesAdded: 1, linesRemoved: 0 },
      })
      emitToolResult(emit, { id: 'c2', name: 'DeleteFile', path: 'elements/characters/废案.md', linesRemoved: 1 })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('建完又反悔')

    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    expect(summaries[0].files).toHaveLength(1)
    expect(summaries[0].files[0]).toMatchObject({
      path: 'elements/characters/废案.md',
      status: 'deleted',
      linesAdded: 1,
      linesRemoved: 1,
    })
    // 完整经过留在 records：先建后删，点开可溯源
    expect(summaries[0].files[0]?.records.map((record) => record.change.type)).toEqual(['created', 'deleted'])
  })

  it('纯删除：删除行数落账并计入聚合（旧账本记录无此字段则为 0）', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, { id: 'c1', name: 'DeleteFile', path: 'chapters/第099章-废稿.txt', linesRemoved: 42 })
      emitToolResult(emit, { id: 'c2', name: 'DeleteFile', path: 'chapters/第098章-旧账.txt' })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('删两章')

    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    expect(summaries[0].files).toHaveLength(2)
    expect(summaries[0].files[0]).toMatchObject({ status: 'deleted', linesAdded: 0, linesRemoved: 42 })
    expect(summaries[0].files[1]).toMatchObject({ status: 'deleted', linesAdded: 0, linesRemoved: 0 })
  })

  it('纯问答轮：不 push change-summary，changedFileCount 为 0', async () => {
    mockedQuery.mockImplementation(async (input) => {
      input.onEvent?.({ type: 'assistant-message', message: { role: 'assistant', content: '只是聊聊' } })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('这个角色叫什么好')

    expect(findChangeSummaries(result.session.messages)).toHaveLength(0)
    expect(result.session.changedFiles).toHaveLength(0)
    expect(result.session.changedFileCount).toBe(0)
  })

  it('停止轮：一律 push change-summary（aborted 标记）；无改动时 files 为空供 UI 降级', async () => {
    mockedQuery.mockImplementation(async (input) => {
      input.onEvent?.({ type: 'aborted', reason: 'user' })
      input.onEvent?.({ type: 'done', messages: input.view.messages, aborted: true })
      return input.view.messages
    })

    const { result } = await runOneTurn('写到一半叫停')

    const summaries = findChangeSummaries(result.session.messages)
    expect(summaries).toHaveLength(1)
    if (summaries[0].kind !== 'change-summary') {
      throw new Error('unreachable')
    }
    expect(summaries[0].aborted).toBe(true)
    expect(summaries[0].files).toEqual([])
  })

  it('file-changed 运行中实时广播：先于 run-finish，且逐条紧跟对应 tool-result 落地', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, { id: 'c1', name: 'CreateFile', path: 'chapters/第001章-初遇.txt' })
      emitToolResult(emit, { id: 'c2', name: 'EditFile', path: 'elements/characters/主角.md' })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { events } = await runOneTurn('建两个文件')

    // 旧实现攒到 run-finish 前批量补发；现在每条都应在收尾之前到达
    const finishIndex = events.findIndex((event) => event.type === 'run-finish')
    const changedIndexes = events.flatMap((event, index) => (event.type === 'file-changed' ? [index] : []))
    expect(finishIndex).toBeGreaterThanOrEqual(0)
    expect(changedIndexes).toHaveLength(2)
    for (const index of changedIndexes) {
      expect(index).toBeLessThan(finishIndex)
    }

    // 第 1 条 file-changed 在第 2 个 tool-call 之前到达（第 1 次工具结果落地即广播，
    // 不等整轮收敛）——这是「侧边列表任务中途刷新」的事件序保证
    const secondToolCallIndex = events.findIndex(
      (event) => event.type === 'message' && event.message.kind === 'tool-call' && event.message.toolCallId === 'c2',
    )
    expect(secondToolCallIndex).toBeGreaterThan(changedIndexes[0])

    // 内容与账本一致
    const first = events[changedIndexes[0]]
    if (first?.type !== 'file-changed') throw new Error('unreachable')
    expect(first.file.change).toMatchObject({ type: 'created', path: 'chapters/第001章-初遇.txt' })
  })

  it('run-error 中途失败：此前已落账的改动仍有 file-changed 实时广播（树不停留旧状态）', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, { id: 'c1', name: 'EditFile', path: 'chapters/第001章-初遇.txt' })
      throw new Error('模型中途崩了')
    })

    const events: AgentUiEvent[] = []
    const errored = new Promise<void>((resolve) => {
      const unsubscribe = subscribeAgentEvents((event) => {
        events.push(event)
        if (event.type === 'run-error') {
          unsubscribe()
          resolve()
        }
      })
    })
    await enqueueMessage({ projectId: 'proj-ledger', text: '改到一半崩', mode: 'queue' })
    await errored

    // 旧行为：报错即一条不广播，文件树停留旧状态直到用户手动刷新
    const changed = events.filter((event) => event.type === 'file-changed')
    expect(changed).toHaveLength(1)
    const record = changed[0]
    if (record?.type !== 'file-changed') throw new Error('unreachable')
    expect(record.file.change).toMatchObject({ type: 'updated', path: 'chapters/第001章-初遇.txt' })
  })
})

// ---------- 测试夹具 ----------

function buildProject(): ProjectSnapshot {
  const handle = createMemoryDirectory('novel')
  // readSystemPrompt 不容缺省：预置 prompts/system.md
  seedFile(handle, 'prompts/system.md', '系统提示')
  return {
    id: 'proj-ledger',
    name: 'Ledger Test',
    rootName: 'novel',
    handle,
    config: stubConfig,
    manifest: {
      projectId: 'proj-ledger',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

function seedFile(root: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()!
  let current = root.__entry
  for (const segment of segments) {
    let next = current.entries.get(segment)
    if (!next) {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }
    if (next.kind !== 'directory') throw new Error(`fixture 冲突：${segment}`)
    current = next
  }
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({ kind: 'directory', name, entries: new Map() })
}

function createDirectoryHandle(entry: MemoryDirectoryEntry): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') return createDirectoryHandle(current)
      if (current) throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') return createFileHandle(current)
      if (current) throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, { type: 'text/plain', lastModified: entry.lastModified })
    },
    async createWritable() {
      let nextContent = ''
      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob ? await data.text() : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}
