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
 * - change-summary 消息 view 按 runId 从账本解析出 records（含 diff）
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
  input: { id: string; name: 'EditFile' | 'CreateFile'; path: string; diff?: { oldText: string; newText: string; linesAdded: number; linesRemoved: number } },
) {
  const call = { id: input.id, name: input.name, input: {} }
  emit({ type: 'tool-call', call, inputSummary: `调用 ${input.name}` })
  emit({
    type: 'tool-result',
    call,
    ok: true,
    resultSummary: `已处理 ${input.path}`,
    fileChange: { type: input.name === 'CreateFile' ? 'created' : 'updated', path: input.path },
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

    // change-summary：面板数据按 runId 从账本解析，含片段级 diff
    const summaries = findChangeSummaries(result.session.messages)
    expect(summaries.length).toBe(1)
    const summary = summaries[0]
    if (summary.kind !== 'change-summary') throw new Error('unreachable')
    expect(summary.aborted).toBeUndefined()
    expect(summary.changes).toHaveLength(3)
    expect(summary.changes[0]).toMatchObject({
      change: { type: 'created', path: 'chapters/第001章-初遇.txt' },
      diff: { oldText: '', newText: '第一章内容', linesAdded: 1, linesRemoved: 0 },
    })
    expect(summary.changes[2]).toMatchObject({
      change: { type: 'updated', path: 'elements/characters/主角.md' },
    })
    expect(summary.changes[2].diff).toBeUndefined()

    // 实时事件流里的 change-summary 同样带解析好的 records
    const liveSummary = events
      .filter((event) => event.type === 'message')
      .map((event) => event.message)
      .find((message) => message.kind === 'change-summary')
    expect(liveSummary).toBeDefined()
    if (liveSummary?.kind === 'change-summary') {
      expect(liveSummary.changes).toHaveLength(3)
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
      expect(summaries[0].changes).toHaveLength(2)
    }
  })

  it('同一文件改两次：会话级计数按路径去重为 1，操作记录两条各自保留', async () => {
    mockedQuery.mockImplementation(async (input) => {
      const emit = input.onEvent?.bind(input) ?? (() => {})
      emitToolResult(emit, {
        id: 'c1',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'a', newText: 'b', linesAdded: 0, linesRemoved: 0 },
      })
      emitToolResult(emit, {
        id: 'c2',
        name: 'EditFile',
        path: 'chapters/第001章-初遇.txt',
        diff: { oldText: 'b', newText: 'c', linesAdded: 1, linesRemoved: 0 },
      })
      input.onEvent?.({ type: 'done', messages: input.view.messages })
      return input.view.messages
    })

    const { result } = await runOneTurn('反复打磨第一章')

    expect(result.session.changedFileCount).toBe(1)
    const summaries = findChangeSummaries(result.session.messages)
    if (summaries[0]?.kind !== 'change-summary') throw new Error('unreachable')
    // 账本天然顺序，同文件两次操作就是两行，不做按文件聚合
    expect(summaries[0].changes).toHaveLength(2)
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

  it('停止轮：一律 push change-summary（aborted 标记）；无改动时 changes 为空供 UI 降级', async () => {
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
    expect(summaries[0].changes).toEqual([])
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
